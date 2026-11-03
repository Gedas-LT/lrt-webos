var Service = require("webos-service");
var https = require("https");

var service = new Service("lt.personal.lrttelevizija.service");

function fieldValue(slice, key, last) {
  var marker = '"' + key + '":"';
  var at = last ? slice.lastIndexOf(marker) : slice.indexOf(marker);
  if (at < 0) {
    return "";
  }
  var rest = slice.substring(at + marker.length);
  var end = rest.indexOf('"');
  if (end <= 0) {
    return "";
  }
  return rest.substring(0, end);
}

function titlesFromHtml(html) {
  var text = html.replace(/\\"/g, '"').replace(/\\u([0-9a-fA-F]{4})/g, function (_, hex) {
    return String.fromCharCode(parseInt(hex, 16));
  });
  var titles = {};
  var ids = ["LTV1", "LTV2"];
  var i;
  for (i = 0; i < ids.length; i++) {
    var id = ids[i];
    var idx = text.indexOf('"channel":"' + id + '"');
    if (idx < 0) {
      continue;
    }
    var startAt = text.lastIndexOf("{", idx);
    var endAt = text.indexOf("}", idx);
    if (startAt < 0 || endAt < 0) {
      continue;
    }
    var record = text.substring(startAt, endAt + 1);
    var title = fieldValue(record, "title", false);
    if (!title) {
      continue;
    }
    var start = fieldValue(record, "time_start", false);
    var finish = fieldValue(record, "time_end", false);
    if (start && finish) {
      title = title + " " + start + "–" + finish;
    }
    titles[id] = title;
  }
  return titles;
}

function fetchPage(path, redirectsLeft, callback) {
  var settled = false;
  function finish(err, html) {
    if (settled) {
      return;
    }
    settled = true;
    callback(err, html);
  }

  var req = https.request(
    {
      hostname: "www.lrt.lt",
      port: 443,
      path: path,
      method: "GET",
      rejectUnauthorized: false,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/html",
        "Accept-Encoding": "identity"
      }
    },
    function (res) {
      var status = res.statusCode || 0;
      var location = res.headers.location;
      if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
        res.resume();
        var nextPath = location;
        var prefix = "https://www.lrt.lt";
        if (location.indexOf(prefix) === 0) {
          nextPath = location.substring(prefix.length) || "/";
        } else if (location.indexOf("/") !== 0) {
          finish(new Error("redirect"));
          return;
        }
        fetchPage(nextPath, redirectsLeft - 1, finish);
        return;
      }
      var body = "";
      res.setEncoding("utf8");
      res.on("data", function (chunk) {
        if (body.length < 2000000) {
          body += chunk;
        }
      });
      res.on("end", function () {
        if (status < 200 || status >= 300) {
          finish(new Error("http"));
          return;
        }
        finish(null, body);
      });
    }
  );
  req.on("error", function (err) {
    finish(err);
  });
  req.setTimeout(15000, function () {
    req.abort();
  });
  req.end();
}

service.register("titles", function (message) {
  fetchPage("/mediateka/tiesiogiai/lrt-televizija", 3, function (err, html) {
    if (err || !html) {
      message.respond({
        returnValue: false,
        errorText: err && err.message ? err.message : "fetch"
      });
      return;
    }
    message.respond({
      returnValue: true,
      titles: titlesFromHtml(html)
    });
  });
});
