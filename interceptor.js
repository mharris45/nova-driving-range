// interceptor.js — runs in the MAIN world at document_start
// Non-blocking intercept of Firestore streaming responses.
// Uses body.tee() so the app's stream is never delayed.

(function() {
  if (window.__gsvInterceptorLoaded) return;
  window.__gsvInterceptorLoaded = true;

  var shotCount = 0;

  function parseFirestoreChunk(text) {
    var re = /\[\[\d+,\[(\{[\s\S]*?\})\s*\]\]\]/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      try {
        var obj = JSON.parse(m[1]);
        var fields = obj.documentChange && obj.documentChange.document &&
                     obj.documentChange.document.fields;
        if (fields && fields.ball_speed !== undefined) {
          var valid = !fields.valid_launch || fields.valid_launch.booleanValue !== false;
          var speed = fields.ball_speed.doubleValue || 0;
          if (valid && speed >= 1) {
            shotCount++;
            console.log('[GSV] ⛳ Shot #' + shotCount + ' — ' + speed + ' mph');
            window.postMessage({ type: 'gsv-firestore-shot', fields: fields }, '*');
          }
        }
      } catch(e) {}
    }
  }

  // ── Patch fetch — tee the body so the app stream is untouched ────────
  var origFetch = window.fetch;

  window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input :
              (input && input.url) ? input.url : '';

    var promise = origFetch.apply(this, arguments);

    if (url.includes('firestore.googleapis.com') && url.includes('Listen')) {
      promise.then(function(response) {
        // Only tap if there's a readable body
        if (!response.body) return;

        // tee() gives us two independent streams — return one to the app,
        // consume the other ourselves. We swap the response body to the app's branch.
        var branches = response.body.tee();
        // Replace the response body with branch[0] for the app
        Object.defineProperty(response, 'body', { value: branches[0] });

        // Read branch[1] ourselves in the background
        var reader = branches[1].getReader();
        var decoder = new TextDecoder();
        function pump() {
          reader.read().then(function(result) {
            if (result.done) return;
            try {
              var chunk = decoder.decode(result.value, { stream: true });
              if (chunk.length > 10) parseFirestoreChunk(chunk);
            } catch(e) {}
            pump();
          }).catch(function() {});
        }
        pump();
      }).catch(function() {});
    }

    return promise;
  };

  // ── Patch XHR (fallback — some Firestore SDKs use XHR) ──────────────
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._gsvUrl = (typeof url === 'string') ? url : '';
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    if (this._gsvUrl.includes('firestore.googleapis.com') &&
        this._gsvUrl.includes('Listen')) {
      var lastLen = 0;
      this.addEventListener('readystatechange', function() {
        if (this.readyState < 3) return;
        try {
          var text = this.responseText;
          if (!text || text.length === lastLen) return;
          var newData = text.substring(lastLen);
          lastLen = text.length;
          parseFirestoreChunk(newData);
        } catch(e) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log('[GSV] Firestore interceptor active');
})();
