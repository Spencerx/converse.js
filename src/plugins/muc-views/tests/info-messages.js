/*global mock, converse */
const { u, stx } = converse.env;

describe("an info message", function () {

    it("is not rendered as a followup message",
            mock.initConverse(['chatBoxesFetched'], {}, async function (_converse) {

        const muc_jid = 'lounge@montague.lit';
        const nick = 'romeo';
        await mock.openAndEnterMUC(_converse, muc_jid, nick);
        const view = _converse.chatboxviews.get(muc_jid);
        let presence = stx`
            <presence xmlns="jabber:client" to="${_converse.jid}" from="${muc_jid}/romeo">
                <x xmlns="http://jabber.org/protocol/muc#user">
                    <status code="201"/>
                    <item role="moderator" affiliation="owner" jid="${_converse.jid}"/>
                    <status code="110"/>
                </x>
            </presence>`;
        _converse.api.connection.get()._dataRecv(mock.createRequest(presence));
        await u.waitUntil(() => view.querySelectorAll('.chat-info').length === 1);

        presence = stx`
            <presence xmlns="jabber:client" to="${_converse.jid}" from="${muc_jid}/romeo1">
                <x xmlns="http://jabber.org/protocol/muc#user">
                    <status code="210"/>
                    <item role="moderator" affiliation="owner" jid="${_converse.jid}"/>
                    <status code="110"/>
                </x>
            </presence>`;
        _converse.api.connection.get()._dataRecv(mock.createRequest(presence));
        await u.waitUntil(() => view.querySelectorAll('.chat-info').length === 2);

        const messages = view.querySelectorAll('.chat-info');
        expect(u.hasClass('chat-msg--followup', messages[0])).toBe(false);
        expect(u.hasClass('chat-msg--followup', messages[1])).toBe(false);
    }));

    it("is not shown if its a duplicate",
            mock.initConverse(['chatBoxesFetched'], {}, async function (_converse) {

        const muc_jid = 'lounge@montague.lit';
        await mock.openAndEnterMUC(_converse, muc_jid, 'romeo');
        const view = _converse.chatboxviews.get(muc_jid);
        const presence = stx`
            <presence xmlns="jabber:client" to="${_converse.jid}" from="${muc_jid}/romeo">
                <x xmlns="http://jabber.org/protocol/muc#user">
                    <status code="201"/>
                    <item role="moderator" affiliation="owner" jid="${_converse.jid}"/>
                    <status code="110"/>
                </x>
            </presence>`;
        _converse.api.connection.get()._dataRecv(mock.createRequest(presence));
        await u.waitUntil(() => view.querySelectorAll('.chat-info').length === 1);

        _converse.api.connection.get()._dataRecv(mock.createRequest(presence));

        const promise = u.getOpenPromise();
        setTimeout(() => {
            expect(view.querySelectorAll('.chat-info').length).toBe(1);
            promise.resolve();
        }, 250);
        return promise;
    }));
});
