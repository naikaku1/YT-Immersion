(function() {
    const scriptTag = document.currentScript;
    const eventId = scriptTag ? scriptTag.getAttribute('data-event-id') : null;
    if (!eventId) return;

    try {
        const player = document.getElementById('movie_player');

        const tracklist = player ? player.getOption('captions', 'tracklist') : [];

        const activeTrack = player ? player.getOption('captions', 'track') : null;

        window.dispatchEvent(new CustomEvent(eventId, {
            detail: { list: tracklist, active: activeTrack }
        }));
    } catch(e) {
        window.dispatchEvent(new CustomEvent(eventId, { detail: { list: [], active: null } }));
    }
})();
