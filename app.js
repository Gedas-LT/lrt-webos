(function () {
  var LIVE_API = "https://www.lrt.lt/servisai/stream_url/live/get_live_url.php?channel=LTV1";
  var REFRESH_LEAD_MS = 2 * 60 * 1000;
  var STALL_MS = 15000;
  var LOAD_MS = 20000;
  var RETRY_MS = 4000;
  var MAX_AUTO = 3;

  var video = document.getElementById("player");
  var statusEl = document.getElementById("status");
  var messageEl = document.getElementById("status-message");
  var hintEl = document.getElementById("status-hint");

  var streams = null;
  var playingUrl = "";
  var sawPlayback = false;
  var userPaused = false;
  var failed = false;
  var waitingForStart = false;
  var fetching = false;
  var autoRetries = 0;
  var refreshTimer = null;
  var stallTimer = null;
  var retryTimer = null;
  var loadTimer = null;
  var errorTimer = null;

  var mediaType =
    "application/vnd.apple.mpegurl;mediaOption=" +
    encodeURI(
      JSON.stringify({
        mediaTransportType: "HLS",
        option: {
          adaptiveStreaming: {
            adaptiveResolution: true,
            maxWidth: 1920,
            maxHeight: 1080
          }
        }
      })
    );

  function showOverlay(message, isError) {
    messageEl.textContent = message;
    hintEl.className = isError ? "" : "hidden";
    statusEl.className = "";
    failed = !!isError;
    if (isError) {
      waitingForStart = false;
      clearStall();
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    }
  }

  function hideOverlay() {
    statusEl.className = "hidden";
    hintEl.className = "hidden";
    failed = false;
    waitingForStart = false;
  }

  function clearStall() {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  function expiryMs(url) {
    var match = /[?&]Expires=(\d+)/.exec(url);
    if (!match) {
      return null;
    }
    var seconds = Number(match[1]);
    if (!isFinite(seconds)) {
      return null;
    }
    return seconds * 1000;
  }

  function scheduleRefresh(url) {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    var expiresAt = expiryMs(url);
    if (!expiresAt) {
      return;
    }
    var delay = expiresAt - Date.now() - REFRESH_LEAD_MS;
    if (delay < 15000) {
      delay = 15000;
    }
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      if (userPaused || failed) {
        return;
      }
      start();
    }, delay);
  }

  function armStallWatch() {
    if (userPaused || failed || waitingForStart || stallTimer || !playingUrl) {
      return;
    }
    var mark = video.currentTime;
    stallTimer = setTimeout(function () {
      stallTimer = null;
      if (userPaused || failed || fetching || waitingForStart) {
        return;
      }
      if (video.currentTime !== mark) {
        return;
      }
      if (sawPlayback) {
        start();
        return;
      }
      failOrRetry();
    }, STALL_MS);
  }

  function playUrl(url) {
    if (errorTimer) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
    playingUrl = url;
    sawPlayback = false;
    userPaused = false;
    clearStall();
    if (loadTimer) {
      clearTimeout(loadTimer);
      loadTimer = null;
    }

    while (video.firstChild) {
      video.removeChild(video.firstChild);
    }
    var source = document.createElement("source");
    source.setAttribute("src", url);
    source.setAttribute("type", mediaType);
    video.appendChild(source);
    try {
      video.load();
    } catch (e) {}

    scheduleRefresh(url);
    loadTimer = setTimeout(function () {
      loadTimer = null;
      if (sawPlayback || userPaused || waitingForStart || failed || playingUrl !== url) {
        return;
      }
      failOrRetry();
    }, LOAD_MS);

    try {
      var result = video.play();
      if (result && typeof result.catch === "function") {
        result.catch(function () {
          if (sawPlayback || playingUrl !== url || video.error) {
            return;
          }
          userPaused = true;
          waitingForStart = true;
          showOverlay("Paspauskite OK, kad pradėtumėte", false);
        });
      }
    } catch (e2) {}
  }

  function fetchStreams(callback) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", LIVE_API, true);
    try {
      xhr.setRequestHeader("Cache-Control", "no-cache");
    } catch (e) {}
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) {
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        callback(new Error("http"));
        return;
      }
      try {
        var json = JSON.parse(xhr.responseText);
        var data = json && json.response && json.response.data;
        var primary = data && typeof data.content === "string" ? data.content.trim() : "";
        var fallback = data && typeof data.content2 === "string" ? data.content2.trim() : "";
        if (!primary && !fallback) {
          callback(new Error("empty"));
          return;
        }
        callback(null, { primary: primary, fallback: fallback });
      } catch (err) {
        callback(err);
      }
    };
    xhr.onerror = function () {
      callback(new Error("network"));
    };
    xhr.send(null);
  }

  function scheduleRetry() {
    if (retryTimer) {
      return;
    }
    autoRetries += 1;
    showOverlay("Jungiamasi…", false);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      start();
    }, RETRY_MS);
  }

  function failOrRetry() {
    if (autoRetries < MAX_AUTO) {
      scheduleRetry();
      return;
    }
    showOverlay("Nepavyko paleisti", true);
  }

  function start() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (fetching) {
      return;
    }
    fetching = true;
    if (!sawPlayback) {
      showOverlay("Jungiamasi…", false);
    }
    fetchStreams(function (err, next) {
      fetching = false;
      if (err) {
        if (sawPlayback && !video.paused && video.readyState >= 2) {
          if (!refreshTimer) {
            refreshTimer = setTimeout(function () {
              refreshTimer = null;
              start();
            }, 60000);
          }
          return;
        }
        failOrRetry();
        return;
      }
      streams = next;
      playUrl(next.primary || next.fallback);
    });
  }

  function markPlaying() {
    if (userPaused) {
      return;
    }
    if (loadTimer) {
      clearTimeout(loadTimer);
      loadTimer = null;
    }
    if (!sawPlayback) {
      autoRetries = 0;
      clearStall();
    }
    sawPlayback = true;
    waitingForStart = false;
    hideOverlay();
  }

  video.addEventListener("playing", markPlaying);
  video.addEventListener("timeupdate", function () {
    if (video.readyState >= 3) {
      markPlaying();
    }
  });

  video.addEventListener("waiting", armStallWatch);
  video.addEventListener("stalled", armStallWatch);

  video.addEventListener("error", function () {
    var urlAtError = playingUrl;
    if (errorTimer) {
      clearTimeout(errorTimer);
    }
    errorTimer = setTimeout(function () {
      errorTimer = null;
      if (playingUrl !== urlAtError || sawPlayback || userPaused || waitingForStart) {
        return;
      }
      if (streams && streams.fallback && playingUrl !== streams.fallback) {
        showOverlay("Jungiamasi…", false);
        playUrl(streams.fallback);
        return;
      }
      failOrRetry();
    }, 400);
  });

  function beginPlayback() {
    waitingForStart = false;
    userPaused = false;
    var expiresAt = expiryMs(playingUrl);
    if (!playingUrl || (expiresAt && expiresAt - Date.now() < REFRESH_LEAD_MS)) {
      autoRetries = 0;
      start();
      return;
    }
    hideOverlay();
    var result = video.play();
    if (result && typeof result.catch === "function") {
      result.catch(function () {
        autoRetries = 0;
        start();
      });
    }
  }

  function exitApp() {
    if (window.webOS && typeof webOS.platformBack === "function") {
      webOS.platformBack();
      return;
    }
    if (window.PalmSystem && typeof window.PalmSystem.platformBack === "function") {
      window.PalmSystem.platformBack();
      return;
    }
    window.close();
  }

  function togglePlayback() {
    if (failed) {
      return;
    }
    if (waitingForStart || video.paused || userPaused) {
      beginPlayback();
      return;
    }
    userPaused = true;
    video.pause();
    showOverlay("Pauzė", false);
  }

  function remoteAction(event) {
    var name = event.key && event.key !== "Unidentified" ? event.key : "";
    var codeName = event.code && event.code !== "Unidentified" ? event.code : "";
    var token = (name || codeName).toLowerCase();

    if (
      token === "backspace" ||
      token === "goback" ||
      token === "xf86back" ||
      token === "browserback" ||
      token === "back" ||
      token === "escape"
    ) {
      return "back";
    }
    if (token === "enter" || token === "numpadenter" || token === "select") {
      return "enter";
    }
    if (token === "mediaplay" || token === "play") {
      return "play";
    }
    if (token === "mediapause" || token === "pause") {
      return "pause";
    }
    if (token === "mediaplaypause") {
      return "toggle";
    }
    return "";
  }

  window.addEventListener("keydown", function (event) {
    var action = remoteAction(event);

    if (action === "back") {
      event.preventDefault();
      exitApp();
      return;
    }

    if (action === "enter") {
      event.preventDefault();
      if (waitingForStart) {
        beginPlayback();
        return;
      }
      if (failed) {
        autoRetries = 0;
        start();
      }
      return;
    }

    if (action === "play") {
      event.preventDefault();
      if (!failed) {
        beginPlayback();
      }
      return;
    }

    if (action === "pause") {
      event.preventDefault();
      if (failed) {
        return;
      }
      userPaused = true;
      video.pause();
      showOverlay("Pauzė", false);
      return;
    }

    if (action === "toggle") {
      event.preventDefault();
      togglePlayback();
    }
  });

  start();
})();
