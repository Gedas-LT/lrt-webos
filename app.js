(function () {
  var LIVE_API = "https://www.lrt.lt/servisai/stream_url/live/get_live_url.php?channel=";
  var CHANNELS = [
    { id: "LTV1", name: "LRT Televizija" },
    { id: "LTV2", name: "LRT Plius" }
  ];
  var STORAGE_KEY = "lrt-channel";
  var REFRESH_LEAD_MS = 2 * 60 * 1000;
  var STALL_MS = 15000;
  var LOAD_MS = 20000;
  var RETRY_MS = 4000;
  var MAX_AUTO = 3;

  var video = document.getElementById("player");
  var statusEl = document.getElementById("status");
  var titleEl = document.getElementById("status-title");
  var messageEl = document.getElementById("status-message");
  var hintEl = document.getElementById("status-hint");
  var channelsEl = document.getElementById("channels");
  var channelNodes = document.querySelectorAll(".channel");

  var streams = null;
  var activeChannel = "";
  var selectedIndex = 0;
  var listOpen = true;
  var programmeTitles = {};
  var channelToken = 0;
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

  function channelById(id) {
    var i;
    for (i = 0; i < CHANNELS.length; i++) {
      if (CHANNELS[i].id === id) {
        return CHANNELS[i];
      }
    }
    return null;
  }

  function storedChannelId() {
    try {
      var id = localStorage.getItem(STORAGE_KEY);
      if (channelById(id)) {
        return id;
      }
    } catch (e) {}
    return "";
  }

  function rememberChannel(id) {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch (e) {}
  }

  function paintChannels() {
    var i;
    for (i = 0; i < channelNodes.length; i++) {
      var id = channelNodes[i].getAttribute("data-id");
      var title = programmeTitles[id] || "";
      var now = channelNodes[i].querySelector(".channel-now");
      channelNodes[i].className = "channel";
      if (i === selectedIndex) {
        channelNodes[i].className += " selected";
      }
      if (title) {
        channelNodes[i].className += " has-title";
      }
      if (now) {
        now.textContent = title;
      }
    }
  }

  function loadTitles() {
    if (!window.webOS || !webOS.service || typeof webOS.service.request !== "function") {
      return;
    }
    try {
      webOS.service.request("luna://lt.personal.lrttelevizija.service", {
        method: "titles",
        parameters: {},
        onSuccess: function (res) {
          var titles = res && res.titles;
          if (!titles) {
            return;
          }
          if (titles.LTV1) {
            programmeTitles.LTV1 = titles.LTV1;
          }
          if (titles.LTV2) {
            programmeTitles.LTV2 = titles.LTV2;
          }
          paintChannels();
        },
        onFailure: function () {}
      });
    } catch (e) {}
  }

  function showList() {
    var i;
    for (i = 0; i < CHANNELS.length; i++) {
      if (CHANNELS[i].id === activeChannel) {
        selectedIndex = i;
      }
    }
    listOpen = true;
    paintChannels();
    loadTitles();
    channelsEl.className = "";
    if (!failed) {
      statusEl.className = "hidden";
    }
  }

  function hideList() {
    listOpen = false;
    channelsEl.className = "hidden";
  }

  function clearTimers() {
    clearStall();
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (loadTimer) {
      clearTimeout(loadTimer);
      loadTimer = null;
    }
    if (errorTimer) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
  }

  function stopVideo() {
    clearTimers();
    try {
      video.pause();
    } catch (e) {}
    while (video.firstChild) {
      video.removeChild(video.firstChild);
    }
    try {
      video.load();
    } catch (e2) {}
  }

  function showOverlay(message, isError) {
    if (listOpen && !isError) {
      return;
    }
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
    var token = channelToken;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      if (token !== channelToken || userPaused || failed) {
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
    var token = channelToken;
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
      if (token !== channelToken || sawPlayback || userPaused || waitingForStart || failed || playingUrl !== url) {
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

  function fetchStreams(channelId, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", LIVE_API + encodeURIComponent(channelId), true);
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
    var token;
    var channelId;
    if (!activeChannel) {
      return;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (fetching) {
      return;
    }
    token = channelToken;
    channelId = activeChannel;
    fetching = true;
    if (!sawPlayback) {
      showOverlay("Jungiamasi…", false);
    }
    fetchStreams(channelId, function (err, next) {
      if (token !== channelToken || channelId !== activeChannel) {
        return;
      }
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
    var tokenAtError = channelToken;
    if (!urlAtError) {
      return;
    }
    if (errorTimer) {
      clearTimeout(errorTimer);
    }
    errorTimer = setTimeout(function () {
      errorTimer = null;
      if (tokenAtError !== channelToken || playingUrl !== urlAtError || sawPlayback || userPaused || waitingForStart) {
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

  function playChannel(id) {
    var channel = channelById(id);
    if (!channel) {
      return;
    }
    channelToken += 1;
    activeChannel = id;
    rememberChannel(id);
    titleEl.textContent = channel.name;
    hideList();
    fetching = false;
    sawPlayback = false;
    userPaused = false;
    failed = false;
    waitingForStart = false;
    streams = null;
    playingUrl = "";
    autoRetries = 0;
    stopVideo();
    start();
  }

  function choose(id) {
    if (id === activeChannel && !failed && (sawPlayback || fetching || playingUrl || waitingForStart || userPaused)) {
      hideList();
      if (waitingForStart || userPaused) {
        beginPlayback();
        return;
      }
      if (!sawPlayback && !fetching) {
        start();
        return;
      }
      if (!sawPlayback) {
        showOverlay("Jungiamasi…", false);
      }
      return;
    }
    playChannel(id);
  }

  function exitApp() {
    userPaused = true;
    try {
      video.pause();
    } catch (e) {}
    // platformBack() opens the Home app row on webOS TV 5 and earlier.
    // window.close() closes the app.
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
    // webOS often reports event.key as "Unidentified" and puts the real button in keyCode.
    var code = event.keyCode || event.which || 0;
    if (code === 461 || code === 8) {
      return "back";
    }
    if (code === 38) {
      return "up";
    }
    if (code === 40) {
      return "down";
    }
    if (code === 13) {
      return "enter";
    }
    if (code === 415) {
      return "play";
    }
    if (code === 19) {
      return "pause";
    }
    if (code === 463 || code === 179 || code === 10252) {
      return "toggle";
    }

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
    if (token === "arrowup" || token === "up") {
      return "up";
    }
    if (token === "arrowdown" || token === "down") {
      return "down";
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

  document.body.tabIndex = -1;
  video.tabIndex = -1;
  document.body.focus();

  document.addEventListener(
    "keydown",
    function (event) {
      var action = remoteAction(event);
      if (!action) {
        return;
      }
      event.preventDefault();
      document.body.focus();

      if (action === "up" || action === "down") {
        if (!listOpen) {
          return;
        }
        selectedIndex += action === "down" ? 1 : -1;
        if (selectedIndex < 0) {
          selectedIndex = CHANNELS.length - 1;
        }
        if (selectedIndex >= CHANNELS.length) {
          selectedIndex = 0;
        }
        paintChannels();
        return;
      }

      if (action === "back") {
        if (listOpen) {
          exitApp();
          return;
        }
        showList();
        return;
      }

      if (action === "enter") {
        if (listOpen) {
          choose(CHANNELS[selectedIndex].id);
          return;
        }
        if (waitingForStart) {
          beginPlayback();
          return;
        }
        if (failed) {
          autoRetries = 0;
          start();
          return;
        }
        showList();
        return;
      }

      if (listOpen) {
        return;
      }

      if (action === "play") {
        if (!failed) {
          beginPlayback();
        }
        return;
      }

      if (action === "pause") {
        if (failed) {
          return;
        }
        userPaused = true;
        video.pause();
        showOverlay("Pauzė", false);
        return;
      }

      if (action === "toggle") {
        togglePlayback();
      }
    },
    true
  );

  var stored = storedChannelId();
  if (stored) {
    selectedIndex = stored === "LTV2" ? 1 : 0;
    playChannel(stored);
  } else {
    showList();
  }
  loadTitles();
  setInterval(loadTitles, 60000);
})();
