/**
 * @typedef {module:plugins-omemo-index.WindowWithLibsignal} WindowWithLibsignal
 * @typedef {import('@converse/headless/shared/types').MessageAttributes} MessageAttributes
 * @typedef {import('@converse/headless/plugins/muc/types').MUCMessageAttributes} MUCMessageAttributes
 * @typedef {import('@converse/headless').ChatBox} ChatBox
 * @typedef {import('@converse/headless/types/shared/message').default} BaseMessage
 */
import { html } from 'lit';
import { __ } from 'i18n';
import { until } from 'lit/directives/until.js';
import { _converse, converse, api, log, u, constants, MUC } from '@converse/headless';
import tplAudio from 'shared/texture/templates/audio.js';
import tplFile from 'templates/file.js';
import tplImage from 'shared/texture/templates/image.js';
import tplVideo from 'shared/texture/templates/video.js';
import { KEY_ALGO, UNTRUSTED, TAG_LENGTH } from './consts.js';
import { MIMETYPES_MAP } from 'utils/file.js';
import { IQError, UserFacingError } from 'shared/errors.js';
import DeviceLists from './devicelists.js';
import { getFileName } from 'utils/html.js';

const { Strophe, sizzle, stx } = converse.env;
const { CHATROOMS_TYPE, PRIVATE_CHAT_TYPE } = constants;
const {
    appendArrayBuffer,
    arrayBufferToBase64,
    arrayBufferToHex,
    arrayBufferToString,
    base64ToArrayBuffer,
    hexToArrayBuffer,
    initStorage,
    isAudioURL,
    isError,
    isImageURL,
    isVideoURL,
    stringToArrayBuffer,
} = u;

/**
 * @param {string} fp
 */
export function formatFingerprint(fp) {
    fp = fp.replace(/^05/, '');
    for (let i = 1; i < 8; i++) {
        const idx = i * 8 + i - 1;
        fp = fp.slice(0, idx) + ' ' + fp.slice(idx);
    }
    return fp;
}

/**
 * @param {string} fp
 */
export function formatFingerprintForQRCode(fp) {
    const sid = _converse.state.omemo_store.get('device_id');
    const jid = _converse.session.get('bare_jid');
    fp = fp.replace(/^05/, '');
    return `xmpp:${jid}?omemo-sid-${sid}=${fp}`;
}

/**
 * @param {Error|IQError|UserFacingError} e
 * @param {ChatBox} chat
 */
export function handleMessageSendError(e, chat) {
    if (e instanceof IQError) {
        chat.save('omemo_supported', false);

        const err_msgs = [];
        if (sizzle(`presence-subscription-required[xmlns="${Strophe.NS.PUBSUB_ERROR}"]`, e.iq).length) {
            err_msgs.push(
                __(
                    "Sorry, we're unable to send an encrypted message because %1$s " +
                        'requires you to be subscribed to their presence in order to see their OMEMO information',
                    e.iq.getAttribute('from')
                )
            );
        } else if (sizzle(`remote-server-not-found[xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"]`, e.iq).length) {
            err_msgs.push(
                __(
                    "Sorry, we're unable to send an encrypted message because the remote server for %1$s could not be found",
                    e.iq.getAttribute('from')
                )
            );
        } else {
            err_msgs.push(__('Unable to send an encrypted message due to an unexpected error.'));
            err_msgs.push(e.iq.outerHTML);
        }
        api.alert('error', __('Error'), err_msgs);
    } else if (e instanceof UserFacingError) {
        api.alert('error', __('Error'), [e.message]);
    }
    throw e;
}

/**
 * @param {string} jid
 */
export async function contactHasOMEMOSupport(jid) {
    /* Checks whether the contact advertises any OMEMO-compatible devices. */
    const devices = await getDevicesForContact(jid);
    return devices.length > 0;
}

/**
 * @param {ChatBox|MUC} chat
 * @param {MessageAttributes} attrs
 * @return {MessageAttributes}
 */
export function getOutgoingMessageAttributes(chat, attrs) {
    if (chat.get('omemo_active') && attrs.body) {
        return {
            ...attrs,
            is_encrypted: true,
            plaintext: attrs.body,
            body: __(
                'This is an OMEMO encrypted message which your client doesn’t seem to support. ' +
                    'Find more information on https://conversations.im/omemo'
            ),
        };
    }
    return attrs;
}

/**
 * @param {string} plaintext
 * @returns {Promise<import('./types').EncryptedMessage>}
 */
async function encryptMessage(plaintext) {
    // The client MUST use fresh, randomly generated key/IV pairs
    // with AES-128 in Galois/Counter Mode (GCM).

    // For GCM a 12 byte IV is strongly suggested as other IV lengths
    // will require additional calculations. In principle any IV size
    // can be used as long as the IV doesn't ever repeat. NIST however
    // suggests that only an IV size of 12 bytes needs to be supported
    // by implementations.
    //
    // https://crypto.stackexchange.com/questions/26783/ciphertext-and-tag-size-and-iv-transmission-with-aes-in-gcm-mode
    const iv = crypto.getRandomValues(new window.Uint8Array(12));
    const key = await crypto.subtle.generateKey(KEY_ALGO, true, ['encrypt', 'decrypt']);
    const algo = /** @type {AesGcmParams} */ {
        iv,
        name: 'AES-GCM',
        tagLength: TAG_LENGTH,
    };
    const encrypted = await crypto.subtle.encrypt(algo, key, stringToArrayBuffer(plaintext));
    const length = encrypted.byteLength - ((128 + 7) >> 3);
    const ciphertext = encrypted.slice(0, length);
    const tag = encrypted.slice(length);
    const exported_key = await crypto.subtle.exportKey('raw', key);
    return {
        tag,
        key: exported_key,
        key_and_tag: appendArrayBuffer(exported_key, tag),
        payload: arrayBufferToBase64(ciphertext),
        iv: arrayBufferToBase64(iv),
    };
}

/**
 * @param {import('./types').EncryptedMessage} obj
 * @returns {Promise<string>}
 */
async function decryptMessage(obj) {
    const key_obj = await crypto.subtle.importKey('raw', obj.key, KEY_ALGO, true, ['encrypt', 'decrypt']);
    const cipher = appendArrayBuffer(base64ToArrayBuffer(obj.payload), obj.tag);
    const algo = /** @type {AesGcmParams} */ {
        name: 'AES-GCM',
        iv: base64ToArrayBuffer(obj.iv),
        tagLength: TAG_LENGTH,
    };
    return arrayBufferToString(await crypto.subtle.decrypt(algo, key_obj, cipher));
}

/**
 * @param {File} file
 * @returns {Promise<File>}
 */
export async function encryptFile(file) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer());
    const exported_key = await window.crypto.subtle.exportKey('raw', key);
    const encrypted_file = new File([encrypted], file.name, { type: file.type, lastModified: file.lastModified });

    Object.assign(encrypted_file, { xep454_ivkey: arrayBufferToHex(iv) + arrayBufferToHex(exported_key) });
    return encrypted_file;
}

/**
 * @param {import('@converse/headless/types/shared/message').default} message
 * @param {import('@converse/headless/shared/types').FileUploadMessageAttributes} attrs
 */
export function setEncryptedFileURL(message, attrs) {
    const url = attrs.oob_url.replace(/^https?:/, 'aesgcm:') + '#' + message.file.xep454_ivkey;
    return Object.assign(attrs, {
        oob_url: null, // Since only the body gets encrypted, we don't set the oob_url
        message: url,
        body: url,
    });
}

/**
 * @param {string} iv
 * @param {string} key
 * @param {ArrayBuffer} cipher
 */
async function decryptFile(iv, key, cipher) {
    const key_obj = await crypto.subtle.importKey('raw', hexToArrayBuffer(key), 'AES-GCM', false, ['decrypt']);
    const algo = /** @type {AesGcmParams} */ {
        name: 'AES-GCM',
        iv: hexToArrayBuffer(iv),
    };
    return crypto.subtle.decrypt(algo, key_obj, cipher);
}

/**
 * @param {string} url
 * @returns {Promise<ArrayBuffer|null>}
 */
async function downloadFile(url) {
    let response;
    try {
        response = await fetch(url);
    } catch (e) {
        log.error(`${e.name}: Failed to download encrypted media: ${url}`);
        log.error(e);
        return null;
    }

    if (response.status >= 200 && response.status < 400) {
        return response.arrayBuffer();
    }
}

/**
 * @param {string} url_text
 * @returns {Promise<string|Error|null>}
 */
async function getAndDecryptFile(url_text) {
    const url = new URL(url_text);
    const protocol = window.location.hostname === 'localhost' && url.hostname === 'localhost' ? 'http' : 'https';
    const http_url = url.toString().replace(/^aesgcm/, protocol);
    const cipher = await downloadFile(http_url);
    if (cipher === null) {
        log.error(`Could not decrypt a received encrypted file ${url.toString()} since it could not be downloaded`);
        return new Error(__('Error: could not decrypt a received encrypted file, because it could not be downloaded'));
    }

    const hash = url.hash.slice(1);
    const key = hash.substring(hash.length - 64);
    const iv = hash.replace(key, '');
    let content;
    try {
        content = await decryptFile(iv, key, cipher);
    } catch (e) {
        log.error(`Could not decrypt file ${url.toString()}`);
        log.error(e);
        return null;
    }
    const [filename, extension] = url.pathname.split('/').pop().split('.');
    const mimetype = MIMETYPES_MAP[extension];
    try {
        const file = new File([content], filename, { 'type': mimetype });
        return URL.createObjectURL(file);
    } catch (e) {
        log.error(`Could not decrypt file ${url.toString()}`);
        log.error(e);
        return null;
    }
}

/**
 * @param {string} file_url
 * @param {string|Error} obj_url
 * @param {import('shared/texture/texture.js').Texture} richtext
 * @returns {import("lit").TemplateResult}
 */
function getTemplateForObjectURL(file_url, obj_url, richtext) {
    if (isError(obj_url)) {
        return html`<p class="error">${/** @type {Error} */ (obj_url).message}</p>`;
    }

    if (isImageURL(file_url)) {
        return tplImage({
            src: obj_url,
            onClick: richtext.onImgClick,
            onLoad: richtext.onImgLoad,
        });
    } else if (isAudioURL(file_url)) {
        return tplAudio(/** @type {string} */ (obj_url));
    } else if (isVideoURL(file_url)) {
        return tplVideo(/** @type {string} */ (obj_url));
    } else {
        return tplFile(obj_url, getFileName(file_url));
    }
}

/**
 * @param {string} text
 * @param {number} offset
 * @param {import('shared/texture/texture.js').Texture} richtext
 */
function addEncryptedFiles(text, offset, richtext) {
    const objs = [];
    try {
        const parse_options = { start: /\b(aesgcm:\/\/)/gi };
        u.withinString(
            text,
            /**
             * @param {string} url
             * @param {number} start
             * @param {number} end
             */
            (url, start, end) => {
                objs.push({ url, start, end });
                return url;
            },
            parse_options
        );
    } catch (error) {
        log.debug(error);
        return;
    }
    objs.forEach((o) => {
        const promise = getAndDecryptFile(o.url).then((obj_url) => getTemplateForObjectURL(o.url, obj_url, richtext));

        const template = html`${until(promise, '')}`;
        richtext.addTemplateResult(o.start + offset, o.end + offset, template);
    });
}

/**
 * @param {import('shared/texture/texture.js').Texture} richtext
 */
export function handleEncryptedFiles(richtext) {
    if (!_converse.state.config.get('trusted')) {
        return;
    }
    richtext.addAnnotations(
        /**
         * @param {string} text
         * @param {number} offset
         */
        (text, offset) => addEncryptedFiles(text, offset, richtext)
    );
}

/**
 * Hook handler for {@link parseMessage} and {@link parseMUCMessage}, which
 * parses the passed in `message` stanza for OMEMO attributes and then sets
 * them on the attrs object.
 * @param {Element} stanza - The message stanza
 * @param {MUCMessageAttributes|MessageAttributes} attrs
 * @returns {Promise<MUCMessageAttributes| MessageAttributes|
        import('./types').MUCMessageAttrsWithEncryption|import('./types').MessageAttrsWithEncryption>}
 */
export async function parseEncryptedMessage(stanza, attrs) {
    if (
        api.settings.get('clear_cache_on_logout') ||
        !attrs.is_encrypted ||
        attrs.encryption_namespace !== Strophe.NS.OMEMO
    ) {
        return attrs;
    }
    const encrypted_el = sizzle(`encrypted[xmlns="${Strophe.NS.OMEMO}"]`, stanza).pop();
    const header = encrypted_el.querySelector('header');
    attrs.encrypted = { 'device_id': header.getAttribute('sid') };

    const device_id = await api.omemo?.getDeviceID();
    const key = device_id && sizzle(`key[rid="${device_id}"]`, encrypted_el).pop();
    if (key) {
        Object.assign(attrs.encrypted, {
            iv: header.querySelector('iv').textContent,
            key: key.textContent,
            payload: encrypted_el.querySelector('payload')?.textContent || null,
            prekey: ['true', '1'].includes(key.getAttribute('prekey')),
        });
    } else {
        return Object.assign(attrs, {
            error_condition: 'not-encrypted-for-this-device',
            error_type: 'Decryption',
            is_ephemeral: true,
            is_error: true,
            type: 'error',
        });
    }
    // https://xmpp.org/extensions/xep-0384.html#usecases-receiving
    if (attrs.encrypted.prekey === true) {
        return decryptPrekeyWhisperMessage(attrs);
    } else {
        return decryptWhisperMessage(attrs);
    }
}

export function onChatInitialized(chatbox) {
    checkOMEMOSupported(chatbox);
    if (chatbox.get('type') === CHATROOMS_TYPE) {
        chatbox.occupants.on('add', (o) => onOccupantAdded(chatbox, o));
        chatbox.features.on('change', () => checkOMEMOSupported(chatbox));
    }
}

export function onChatComponentInitialized(el) {
    el.listenTo(el.model.messages, 'add', (message) => {
        if (message.get('is_encrypted') && !message.get('is_error')) {
            el.model.save('omemo_supported', true);
        }
    });
    el.listenTo(el.model, 'change:omemo_supported', () => {
        if (!el.model.get('omemo_supported') && el.model.get('omemo_active')) {
            el.model.set('omemo_active', false);
        } else {
            // Manually trigger an update, setting omemo_active to
            // false above will automatically trigger one.
            el.querySelector('converse-chat-toolbar')?.requestUpdate();
        }
    });
    el.listenTo(el.model, 'change:omemo_active', () => {
        el.querySelector('converse-chat-toolbar').requestUpdate();
    });
}

/**
 * @param {string} jid
 * @param {number} id
 */
export function getSessionCipher(jid, id) {
    const { libsignal } = /** @type WindowWithLibsignal */ (window);
    const address = new libsignal.SignalProtocolAddress(jid, id);
    return new libsignal.SessionCipher(_converse.state.omemo_store, address);
}

/**
 * We use the bare, real (i.e. non-MUC) JID as encrypted session identifier.
 * @param {MUCMessageAttributes|MessageAttributes} attrs
 */
function getJIDForDecryption(attrs) {
    let from_jid;
    if (attrs.sender === 'me') {
        from_jid = _converse.session.get('bare_jid');
    } else if (attrs.contact_jid) {
        from_jid = attrs.contact_jid;
    } else if ('from_real_jid' in attrs) {
        from_jid = attrs.from_real_jid;
    } else {
        from_jid = attrs.from;
    }

    if (!from_jid) {
        Object.assign(attrs, {
            error_text: __(
                'Sorry, could not decrypt a received OMEMO ' +
                    "message because we don't have the XMPP address for that user."
            ),
            error_type: 'Decryption',
            is_ephemeral: true,
            is_error: true,
            type: 'error',
        });
        throw new Error('Could not find JID to decrypt OMEMO message for');
    }
    return from_jid;
}

async function handleDecryptedWhisperMessage(attrs, key_and_tag) {
    const from_jid = getJIDForDecryption(attrs);
    const devicelist = await api.omemo.devicelists.get(from_jid, true);
    const encrypted = attrs.encrypted;
    let device = devicelist.devices.get(encrypted.device_id);
    if (!device) {
        device = await devicelist.devices.create({ 'id': encrypted.device_id, 'jid': from_jid }, { 'promise': true });
    }
    if (encrypted.payload) {
        const key = key_and_tag.slice(0, 16);
        const tag = key_and_tag.slice(16);
        const result = await omemo.decryptMessage(Object.assign(encrypted, { key, tag }));
        device.save('active', true);
        return result;
    }
}

function getDecryptionErrorAttributes(e) {
    return {
        'error_text':
            __('Sorry, could not decrypt a received OMEMO message due to an error.') + ` ${e.name} ${e.message}`,
        'error_condition': e.name,
        'error_message': e.message,
        'error_type': 'Decryption',
        'is_ephemeral': true,
        'is_error': true,
        'type': 'error',
    };
}

/**
 * @param {MUCMessageAttributes|MessageAttributes} attrs
 */
async function decryptPrekeyWhisperMessage(attrs) {
    const from_jid = getJIDForDecryption(attrs);
    const session_cipher = getSessionCipher(from_jid, parseInt(attrs.encrypted.device_id, 10));
    const key = base64ToArrayBuffer(attrs.encrypted.key);
    let key_and_tag;
    try {
        key_and_tag = await session_cipher.decryptPreKeyWhisperMessage(key, 'binary');
    } catch (e) {
        // TODO from the XEP:
        // There are various reasons why decryption of an
        // OMEMOKeyExchange or an OMEMOAuthenticatedMessage
        // could fail. One reason is if the message was
        // received twice and already decrypted once, in this
        // case the client MUST ignore the decryption failure
        // and not show any warnings/errors. In all other cases
        // of decryption failure, clients SHOULD respond by
        // forcibly doing a new key exchange and sending a new
        // OMEMOKeyExchange with a potentially empty SCE
        // payload. By building a new session with the original
        // sender this way, the invalid session of the original
        // sender will get overwritten with this newly created,
        // valid session.
        log.error(`${e.name} ${e.message}`);
        return Object.assign(attrs, getDecryptionErrorAttributes(e));
    }
    // TODO from the XEP:
    // When a client receives the first message for a given
    // ratchet key with a counter of 53 or higher, it MUST send
    // a heartbeat message. Heartbeat messages are normal OMEMO
    // encrypted messages where the SCE payload does not include
    // any elements. These heartbeat messages cause the ratchet
    // to forward, thus consequent messages will have the
    // counter restarted from 0.
    try {
        const plaintext = await handleDecryptedWhisperMessage(attrs, key_and_tag);
        const { omemo_store } = _converse.state;
        await omemo_store.generateMissingPreKeys();
        await omemo_store.publishBundle();
        if (plaintext) {
            return Object.assign(attrs, { 'plaintext': plaintext });
        } else {
            return Object.assign(attrs, { 'is_only_key': true });
        }
    } catch (e) {
        log.error(`${e.name} ${e.message}`);
        return Object.assign(attrs, getDecryptionErrorAttributes(e));
    }
}

/**
 * @param {MUCMessageAttributes|MessageAttributes} attrs
 */
async function decryptWhisperMessage(attrs) {
    const from_jid = getJIDForDecryption(attrs);
    const session_cipher = getSessionCipher(from_jid, parseInt(attrs.encrypted.device_id, 10));
    const key = base64ToArrayBuffer(attrs.encrypted.key);
    try {
        const key_and_tag = await session_cipher.decryptWhisperMessage(key, 'binary');
        const plaintext = await handleDecryptedWhisperMessage(attrs, key_and_tag);
        return Object.assign(attrs, { 'plaintext': plaintext });
    } catch (e) {
        log.error(`${e.name} ${e.message}`);
        return Object.assign(attrs, getDecryptionErrorAttributes(e));
    }
}

/**
 * Given an XML element representing a user's OMEMO bundle, parse it
 * and return a map.
 * @param {Element} bundle_el
 * @returns {import('./types').Bundle}
 */
export function parseBundle(bundle_el) {
    const signed_prekey_public_el = bundle_el.querySelector('signedPreKeyPublic');
    const signed_prekey_signature_el = bundle_el.querySelector('signedPreKeySignature');
    const prekeys = sizzle(`prekeys > preKeyPublic`, bundle_el).map(
        /** @param {Element} el */ (el) => ({
            id: parseInt(el.getAttribute('preKeyId'), 10),
            key: el.textContent,
        })
    );
    return {
        identity_key: bundle_el.querySelector('identityKey').textContent.trim(),
        signed_prekey: {
            id: parseInt(signed_prekey_public_el.getAttribute('signedPreKeyId'), 10),
            public_key: signed_prekey_public_el.textContent,
            signature: signed_prekey_signature_el.textContent,
        },
        prekeys,
    };
}

/**
 * @param {string} jid
 */
export async function generateFingerprints(jid) {
    const devices = await getDevicesForContact(jid);
    return Promise.all(devices.map((d) => generateFingerprint(d)));
}

/**
 * @param {import('./device.js').default} device
 */
export async function generateFingerprint(device) {
    if (device.get('bundle')?.fingerprint) {
        return;
    }
    const bundle = await device.getBundle();
    bundle['fingerprint'] = arrayBufferToHex(base64ToArrayBuffer(bundle['identity_key']));
    device.save('bundle', bundle);
    device.trigger('change:bundle'); // Doesn't get triggered automatically due to pass-by-reference
}

/**
 * @param {string} jid
 * @returns {Promise<import('./devices.js').default>}
 */
export async function getDevicesForContact(jid) {
    await api.waitUntil('OMEMOInitialized');
    const devicelist = await api.omemo.devicelists.get(jid, true);
    await devicelist.fetchDevices();
    return devicelist.devices;
}

/**
 * @param {string} jid
 * @param {string} device_id
 * @returns {Promise<import('./device.js').default[]>}
 */
export async function getDeviceForContact(jid, device_id) {
    const devices = await getDevicesForContact(jid);
    return devices.get(device_id);
}

export async function generateDeviceID() {
    const { libsignal } = /** @type WindowWithLibsignal */ (window);

    /* Generates a device ID, making sure that it's unique */
    const bare_jid = _converse.session.get('bare_jid');
    const devicelist = await api.omemo.devicelists.get(bare_jid, true);
    const existing_ids = devicelist.devices.pluck('id');
    let device_id = libsignal.KeyHelper.generateRegistrationId();

    // Before publishing a freshly generated device id for the first time,
    // a device MUST check whether that device id already exists, and if so, generate a new one.
    let i = 0;
    while (existing_ids.includes(device_id)) {
        device_id = libsignal.KeyHelper.generateRegistrationId();
        i++;
        if (i === 10) {
            throw new Error('Unable to generate a unique device ID');
        }
    }
    return device_id.toString();
}

/**
 * @param {import('./device.js').default} device
 */
async function buildSession(device) {
    const { libsignal } = /** @type WindowWithLibsignal */ (window);
    const address = new libsignal.SignalProtocolAddress(device.get('jid'), device.get('id'));
    const sessionBuilder = new libsignal.SessionBuilder(_converse.state.omemo_store, address);
    const prekey = device.getRandomPreKey();
    const bundle = await device.getBundle();
    return sessionBuilder.processPreKey({
        registrationId: parseInt(device.get('id'), 10),
        identityKey: base64ToArrayBuffer(bundle.identity_key),
        signedPreKey: {
            keyId: bundle.signed_prekey.id, // <Number>
            publicKey: base64ToArrayBuffer(bundle.signed_prekey.public_key),
            signature: base64ToArrayBuffer(bundle.signed_prekey.signature),
        },
        preKey: {
            keyId: prekey.id, // <Number>
            publicKey: base64ToArrayBuffer(prekey.key),
        },
    });
}

/**
 * @param {import('./device.js').default} device
 */
export async function getSession(device) {
    if (!device.get('bundle')) {
        log.error(`Could not build an OMEMO session for device ${device.get('id')} because we don't have its bundle`);
        return null;
    }
    const { libsignal } = /** @type WindowWithLibsignal */ (window);
    const address = new libsignal.SignalProtocolAddress(device.get('jid'), device.get('id'));
    const session = await _converse.state.omemo_store.loadSession(address.toString());
    if (session) {
        return session;
    } else {
        try {
            return await buildSession(device);
        } catch (e) {
            log.error(`Could not build an OMEMO session for device ${device.get('id')}`);
            log.error(e);
            return null;
        }
    }
}

/**
 * @param {Element} stanza
 */
async function updateBundleFromStanza(stanza) {
    const items_el = sizzle(`items`, stanza).pop();
    if (!items_el || !items_el.getAttribute('node').startsWith(Strophe.NS.OMEMO_BUNDLES)) {
        return;
    }
    const device_id = items_el.getAttribute('node').split(':')[1];
    const jid = stanza.getAttribute('from');
    const bundle_el = sizzle(`item > bundle`, items_el).pop();
    const devicelist = await api.omemo.devicelists.get(jid, true);
    const device = devicelist.devices.get(device_id) || devicelist.devices.create({ 'id': device_id, jid });
    device.save({ 'bundle': parseBundle(bundle_el) });
}

/**
 * @param {Element} stanza
 */
async function updateDevicesFromStanza(stanza) {
    const items_el = sizzle(`items[node="${Strophe.NS.OMEMO_DEVICELIST}"]`, stanza).pop();
    if (!items_el) return;

    const device_selector = `item list[xmlns="${Strophe.NS.OMEMO}"] device`;
    const device_ids = sizzle(device_selector, items_el).map((d) => d.getAttribute('id'));
    const jid = stanza.getAttribute('from');
    const devicelist = await api.omemo.devicelists.get(jid, true);
    const devices = devicelist.devices;
    const removed_ids = devices.pluck('id').filter((id) => !device_ids.includes(id));

    const bare_jid = _converse.session.get('bare_jid');

    removed_ids.forEach(
        /** @param {string} id */ (id) => {
            if (jid === bare_jid && id === _converse.state.omemo_store.get('device_id')) {
                return; // We don't set the current device as inactive
            }
            devices.get(id).save('active', false);
        }
    );
    device_ids.forEach(
        /** @param {string} device_id */ (device_id) => {
            const device = devices.get(device_id);
            if (device) {
                device.save('active', true);
            } else {
                devices.create({ id: device_id, jid });
            }
        }
    );
    if (u.isSameBareJID(bare_jid, jid)) {
        // Make sure our own device is on the list
        // (i.e. if it was removed, add it again).
        devicelist.publishCurrentDevice(device_ids);
    }
}

/**
 * @param {Element} message
 */
async function handlePEPPush(message) {
    try {
        if (sizzle(`event[xmlns="${Strophe.NS.PUBSUB}#event"]`, message).length) {
            await api.waitUntil('OMEMOInitialized');
            await updateDevicesFromStanza(message);
            await updateBundleFromStanza(message);
        }
    } catch (e) {
        log.error(e);
    }
}

/**
 * Register a pubsub handler for devices pushed from other connected clients
 */
export function registerPEPPushHandler() {
    api.connection.get().addHandler(
        /** @param {Element} message */
        (message) => {
            handlePEPPush(message);
            return true;
        },
        null,
        'message',
        'headline'
    );
}

export async function restoreOMEMOSession() {}

async function fetchDeviceLists() {
    const bare_jid = _converse.session.get('bare_jid');

    _converse.state.devicelists = new DeviceLists();
    const id = `converse.devicelists-${bare_jid}`;
    initStorage(_converse.state.devicelists, id);
    await new Promise((resolve) => {
        _converse.state.devicelists.fetch({
            success: resolve,
            error: (_m, e) => {
                log.error(e);
                resolve();
            },
        });
    });
    // Call API method to wait for our own device list to be fetched from the
    // server or to be created. If we have no pre-existing OMEMO session, this
    // will cause a new device and bundle to be generated and published.
    await api.omemo.devicelists.get(bare_jid, true);
}

/**
 * @param {boolean} reconnecting
 */
export async function initOMEMO(reconnecting) {
    if (reconnecting) {
        return;
    }
    if (!_converse.state.config.get('trusted') || api.settings.get('clear_cache_on_logout')) {
        log.warn('Not initializing OMEMO, since this browser is not trusted or clear_cache_on_logout is set to true');
        return;
    }
    try {
        await fetchDeviceLists();
        await api.omemo.session.restore();
        await _converse.state.omemo_store.publishBundle();
    } catch (e) {
        log.error('Could not initialize OMEMO support');
        log.error(e);
        return;
    }
    /**
     * Triggered once OMEMO support has been initialized
     * @event _converse#OMEMOInitialized
     * @example _converse.api.listen.on('OMEMOInitialized', () => { ... });
     */
    api.trigger('OMEMOInitialized');
}

/**
 * @param {MUC} chatroom
 * @param {import('@converse/headless/types/plugins/muc/occupant').default} occupant
 */
async function onOccupantAdded(chatroom, occupant) {
    if (occupant.isSelf() || !chatroom.features.get('nonanonymous') || !chatroom.features.get('membersonly')) {
        return;
    }
    if (chatroom.get('omemo_active')) {
        const supported = await contactHasOMEMOSupport(occupant.get('jid'));
        if (!supported) {
            chatroom.createMessage({
                'message': __(
                    "%1$s doesn't appear to have a client that supports OMEMO. " +
                        'Encrypted chat will no longer be possible in this grouchat.',
                    occupant.get('nick')
                ),
                'type': 'error',
            });
            chatroom.save({ 'omemo_active': false, 'omemo_supported': false });
        }
    }
}

async function checkOMEMOSupported(chatbox) {
    let supported;
    if (chatbox.get('type') === CHATROOMS_TYPE) {
        await api.waitUntil('OMEMOInitialized');
        supported = chatbox.features.get('nonanonymous') && chatbox.features.get('membersonly');
    } else if (chatbox.get('type') === PRIVATE_CHAT_TYPE) {
        supported = await contactHasOMEMOSupport(chatbox.get('jid'));
    }
    chatbox.set('omemo_supported', !!supported);
    if (supported && api.settings.get('omemo_default')) {
        chatbox.set('omemo_active', true);
    }
}

/**
 * @param {MouseEvent} ev
 */
function toggleOMEMO(ev) {
    ev.stopPropagation();
    ev.preventDefault();
    const toolbar_el = u.ancestor(ev.target, 'converse-chat-toolbar');
    if (!toolbar_el.model.get('omemo_supported')) {
        let messages;
        if (toolbar_el.model.get('type') === CHATROOMS_TYPE) {
            messages = [
                __(
                    'Cannot use end-to-end encryption in this groupchat, ' +
                        'either the groupchat has some anonymity or not all participants support OMEMO.'
                ),
            ];
        } else {
            messages = [
                __(
                    "Cannot use end-to-end encryption because %1$s uses a client that doesn't support OMEMO.",
                    toolbar_el.model.contact.getDisplayName()
                ),
            ];
        }
        return api.alert('error', __('Error'), messages);
    }
    toolbar_el.model.save({ 'omemo_active': !toolbar_el.model.get('omemo_active') });
}

/**
 * @param {import('shared/chat/toolbar').ChatToolbar} toolbar_el
 * @param {Array<import('lit').TemplateResult>} buttons
 */
export function getOMEMOToolbarButton(toolbar_el, buttons) {
    const model = toolbar_el.model;
    const is_muc = model.get('type') === CHATROOMS_TYPE;
    let title;
    if (model.get('omemo_supported')) {
        const i18n_plaintext = __('Messages are being sent in plaintext');
        const i18n_encrypted = __('Messages are sent encrypted');
        title = model.get('omemo_active') ? i18n_encrypted : i18n_plaintext;
    } else if (is_muc) {
        title = __(
            'This groupchat needs to be members-only and non-anonymous in ' +
                'order to support OMEMO encrypted messages'
        );
    } else {
        title = __('OMEMO encryption is not supported');
    }

    let color;
    if (model.get('omemo_supported')) {
        if (model.get('omemo_active')) {
            color = is_muc ? `var(--muc-color)` : `var(--chat-color)`;
        } else {
            color = `var(--error-color)`;
        }
    } else {
        color = `var(--disabled-color)`;
    }
    buttons.push(html`
        <button
            type="button"
            class="btn toggle-omemo"
            title="${title}"
            data-disabled=${!model.get('omemo_supported')}
            @click=${toggleOMEMO}
        >
            <converse-icon
                class="fa ${model.get('omemo_active') ? `fa-lock` : `fa-unlock`}"
                path-prefix="${api.settings.get('assets_path')}"
                size="1em"
                color="${color}"
            ></converse-icon>
        </button>
    `);
    return buttons;
}

/**
 * @param {MUC|ChatBox} chatbox
 * @returns {Promise<import('./device.js').default[]>}
 */
async function getBundlesAndBuildSessions(chatbox) {
    const no_devices_err = __('Sorry, no devices found to which we can send an OMEMO encrypted message.');
    let devices;
    if (chatbox instanceof MUC) {
        const collections = await Promise.all(
            chatbox.occupants.map(
                /** @param {import('@converse/headless/types/plugins/muc/occupant').default} o */
                (o) => getDevicesForContact(o.get('jid'))
            )
        );
        devices = collections.reduce((a, b) => a.concat(b.models), []);
    } else if (chatbox.get('type') === PRIVATE_CHAT_TYPE) {
        const their_devices = await getDevicesForContact(chatbox.get('jid'));
        if (their_devices.length === 0) {
            throw new UserFacingError(no_devices_err);
        }
        const bare_jid = _converse.session.get('bare_jid');
        const own_list = await api.omemo.devicelists.get(bare_jid);
        const own_devices = own_list.devices;
        devices = [...own_devices.models, ...their_devices.models];
    }
    // Filter out our own device
    const id = _converse.state.omemo_store.get('device_id');
    devices = devices.filter(/** @param {import('./device.js').default} d */ (d) => d.get('id') !== id);

    // Fetch bundles if necessary
    await Promise.all(devices.map((d) => d.getBundle()));

    const sessions = devices.filter((d) => d).map((d) => getSession(d));
    await Promise.all(sessions);
    if (sessions.includes(null)) {
        // We couldn't build a session for certain devices.
        devices = devices.filter((d) => sessions[devices.indexOf(d)]);
        if (devices.length === 0) {
            throw new UserFacingError(no_devices_err);
        }
    }
    return devices;
}

/**
 * @param {ArrayBuffer} key_and_tag
 * @param {import('./device.js').default} device
 */
function encryptKey(key_and_tag, device) {
    return getSessionCipher(device.get('jid'), device.get('id'))
        .encrypt(key_and_tag)
        .then((payload) => ({ payload, device }));
}

/**
 * @param {MUC|ChatBox} chat
 * @param {{ message: BaseMessage, stanza: import('strophe.js').Builder }} data
 * @return {Promise<{ message: BaseMessage, stanza: import('strophe.js').Builder }>}
 */
export async function createOMEMOMessageStanza(chat, data) {
    let { stanza } = data;
    const { message } = data;
    if (!message.get('is_encrypted')) {
        return data;
    }
    if (!message.get('body')) {
        throw new Error('No message body to encrypt!');
    }
    const devices = await getBundlesAndBuildSessions(chat);
    const { key_and_tag, iv, payload } = await omemo.encryptMessage(message.get('plaintext'));

    // The 16 bytes key and the GCM authentication tag (The tag
    // SHOULD have at least 128 bit) are concatenated and for each
    // intended recipient device, i.e. both own devices as well as
    // devices associated with the contact, the result of this
    // concatenation is encrypted using the corresponding
    // long-standing SignalProtocol session.
    const dicts = await Promise.all(
        devices
            .filter((device) => device.get('trusted') != UNTRUSTED && device.get('active'))
            .map((device) => encryptKey(key_and_tag, device))
    );

    // An encrypted header is added to the message for
    // each device that is supposed to receive it.
    // These headers simply contain the key that the
    // payload message is encrypted with,
    // and they are separately encrypted using the
    // session corresponding to the counterpart device.
    stanza
        .cnode(
            stx`
            <encrypted xmlns="${Strophe.NS.OMEMO}">
                <header sid="${_converse.state.omemo_store.get('device_id')}">
                    ${dicts.map(({ payload, device }) => {
                        const prekey = 3 == parseInt(payload.type, 10);
                        if (prekey) {
                            return stx`<key rid="${device.get('id')}" prekey="true">${btoa(payload.body)}</key>`;
                        }
                        return stx`<key rid="${device.get('id')}">${btoa(payload.body)}</key>`;
                    })}
                    <iv>${iv}</iv>
                </header>
                <payload>${payload}</payload>
            </encrypted>`
        )
        .root();

    stanza.cnode(stx`<store xmlns="${Strophe.NS.HINTS}"/>`).root();
    stanza.cnode(stx`<encryption xmlns="${Strophe.NS.EME}" namespace="${Strophe.NS.OMEMO}"/>`).root();
    return { message, stanza };
}

export const omemo = {
    decryptMessage,
    encryptMessage,
    formatFingerprint,
};
