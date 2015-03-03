/**
 * This is an example of a basic node.js script that performs
 * the Authorization Code oAuth2 flow to authenticate against
 * the Spotify Accounts.
 *
 * For more information, read
 * https://developer.spotify.com/web-api/authorization-guide/#authorization_code_flow
 */

// Some includes
var express = require('express'); // Express web server framework
var request = require('request'); // "Request" library
var querystring = require('querystring');
var cookieParser = require('cookie-parser');
var levenshtein = require('levenshtein');
var crypto = require('crypto');

if (!process.env.PORT) {
  // Load environment variables on local setup
  var env = require('node-env-file');
  env(__dirname + '/.env');
}

// Redis setup
var redis = require('redis');
var url = require('url');
var redisURL = url.parse(process.env.REDIS_URL || 'http://localhost:6379');
var $redis = redis.createClient(redisURL.port, redisURL.hostname, {no_ready_check: true});
if (redisURL.auth) {
  $redis.auth(redisURL.auth.split(":")[1]);
}

var client_id = process.env.SPOTIFY_CLIENT_ID; // Your client id
var client_secret = process.env.SPOTIFY_CLIENT_SECRET; // Your client secret
var redirect_uri = process.env.CALLBACK_URI; // Your redirect uri

/**
 * Generates a random string containing numbers and letters
 * @param  {number} length The length of the string
 * @return {string} The generated string
 */
var generateRandomString = function(length) {
  var text = '';
  var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (var i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

var stateKey = 'spotify_auth_state';
var accessTokenKey = 'access_token';

var app = express();

app.use(express.static(__dirname + '/public'))
   .use(cookieParser());

app.get('/refresh_redis', function(req, res) {
	$redis.set("ping", new Date().getTime());
});

app.get('/login', function(req, res) {
  var accessToken = req.query.access_token;

  var state = generateRandomString(16);
  res.cookie(stateKey, state);
  res.cookie(accessTokenKey, accessToken); // track which access token we are authing for

  // your application requests authorization
  var scope = 'user-read-private user-read-email playlist-modify-private playlist-modify-public playlist-read-private';
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
      state: state
    }));
});

app.get('/callback', function(req, res) {

  // your application requests refresh and access tokens
  // after checking the state parameter

  var code = req.query.code || null;
  var state = req.query.state || null;
  var storedState = req.cookies ? req.cookies[stateKey] : null;
  var storedAccessToken = req.cookies ? req.cookies[accessTokenKey] : null;

  if (state === null || state !== storedState) {
    res.redirect('/#' +
      querystring.stringify({
        error: 'state_mismatch'
      }));
  } else {
    res.clearCookie(stateKey);
    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        code: code,
        redirect_uri: redirect_uri,
        grant_type: 'authorization_code'
      },
      headers: {
        'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))
      },
      json: true
    };

    request.post(authOptions, function(error, response, body) {
      if (!error && response.statusCode === 200) {

        var access_token = body.access_token,
            refresh_token = body.refresh_token;


        var options = {
          url: 'https://api.spotify.com/v1/me',
          headers: { 'Authorization': 'Bearer ' + access_token },
          json: true
        };

        // use the access token to access the Spotify Web API
        request.get(options, function(error, response, body) {
          console.log(body);

          // Store the spotify credentials & userid in redis keyed by the node-side access token
          if (storedAccessToken && typeof(storedAccessToken) == "string") {
            $redis.set(buildRedisKeyforAccessToken(storedAccessToken), JSON.stringify({
              access_token: access_token,
              refresh_token: refresh_token,
              user_id: body.id
            }));
          }
        });

        // we can also pass the token to the browser to make requests from there
        res.redirect('/#' +
          querystring.stringify({
            access_token: access_token,
            refresh_token: refresh_token
          }));
      } else {
        res.redirect('/#' +
          querystring.stringify({
            error: 'invalid_token'
          }));
      }
    });
  }
});

/**
 * Uses the Spotify refresh token tied to the credentials in the current request to refresh the respective access token,
 * which has presumably now expired. Then, calls a callback (most likely to re-try the original request that made it
 * clear that refreshing was necessary) with the updated spotify credentials.
 * @param req express request object
 * @param callback called with an object with the properties: access_token, refresh_token, user_id
 */
function refreshToken(req, callback) {
  getSpotifyCredentials(req, function(spotifyCredentials) {
    var refresh_token = spotifyCredentials.refresh_token;
    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      headers: { 'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64')) },
      form: {
        grant_type: 'refresh_token',
        refresh_token: refresh_token
      },
      json: true
    };

    request.post(authOptions, function(error, response, body) {
      if (!error && response.statusCode === 200) {
        var requestAccessToken = req.query.access_token;
        spotifyCredentials.access_token = body.access_token;
        $redis.set(buildRedisKeyforAccessToken(requestAccessToken), JSON.stringify(spotifyCredentials));

        callback(spotifyCredentials);
      }
    });
  });
}

function buildRedisKeyforAccessToken(token) {
  return "spotify-access-token-" + token;
}

app.get('/generate_access_token', function(req, res) {
  // Recursive function to reliably generate a unique access token or fail
  var generateAccessToken = function(res, retriesLeft) {
    crypto.randomBytes(48, function(ex, buf) {
      var token = buf.toString('hex');
      $redis.get(buildRedisKeyforAccessToken(token), function(err, reply) {
        if (reply) {
          if (retriesLeft > 0) {
            generateAccessToken(res, --retriesLeft);
          } else {
            res.send({
              success: false,
              error: 1,
              error_name: "Could not generate unique token"
            });
          }
        } else {
          res.send({
            success: true,
            access_token: token
          });
        }
      });
    });
  };

  generateAccessToken(res);
});

/**
 * Extracts spotify access/refresh tokens from a node-side access token specified in the given request.
 * @param req express request
 * @param callback called with an object containing access_token, refresh_token, and user_id
 * @returns {*}
 */
function getSpotifyCredentials(req, callback) {
  var accessToken = req.query.access_token;

  if (accessToken && accessToken.length == 96) {
    $redis.get(buildRedisKeyforAccessToken(accessToken), function (err, reply) {
      if (reply) {
        callback(JSON.parse(reply));
      } else {
        callback(null);
      }
    });
  } else {
    callback(null);
  }
}

/**
 * Runs an authenticated Spotify Web API request, with support for auto-refreshing expired access tokens.
 * @param options object with keys:
 *  relative url, e.g. '/me' (required)
 *  method (required)
 *  callback (if specified, will be called with [error,response,body])
 *  res (express response object -- if callback unspecified, will send Spotify response body directly to this object)
 *  query (optional, get query vars)
 *  form (optional, post body)
 * @param req express request object
 */
function authed_spotify_request(options, req) {
  if (!options || !options.method || !request[options.method]) return false;

  getSpotifyCredentials(req, function(spotifyCredentials) {
    if (spotifyCredentials && spotifyCredentials.access_token) {
      var spotifyRequestInternal = function(spotifyCredentialsToUse) {
        request[options.method]({
          url: 'https://api.spotify.com/v1' + options.url,
          qs: options.query,
          form: options.form,
          json: true,
          headers: { 'Authorization': 'Bearer ' + spotifyCredentialsToUse.access_token }
        }, function(error, response, body) {
          if (response.statusCode == 401) {
            refreshToken(req, function(newSpotifyCredentials) {
              spotifyRequestInternal(newSpotifyCredentials);
            });
          } else {
            if (options.callback) {
              options.callback(error, response, body);
            } else if (options.res) {
              options.res.send(body);
            } else {
              // Somehow notify someone!!
              console.log(body);
            }
          }
        });
      };

      spotifyRequestInternal(spotifyCredentials);
    }
  });
}

app.get('/playlists', function(req, res) {
  getSpotifyCredentials(req, function(spotifyCredentials) {
    if (spotifyCredentials) {
      authed_spotify_request({
        method: 'get',
        url: '/users/' + spotifyCredentials.user_id + '/playlists',
        res: res
      }, req);
    } else {
      res.send({
        success: false,
        error: 3,
        error_name: 'Invalid or missing access_token'
      });
    }
  });
});

app.get('/add_song', function(req, res) {
  if (req.query.playlist_id && req.query.track_uri
      && req.query.playlist_id.indexOf('/') == -1
      && req.query.track_uri.indexOf('/') == -1) {
    getSpotifyCredentials(req, function(spotifyCredentials) {
      if (spotifyCredentials) {
        authed_spotify_request({
          method: 'post',
          url: '/users/' + spotifyCredentials.user_id + '/playlists/' + req.query.playlist_id + '/tracks'
            + '?uris=' + req.query.track_uri,
          callback: function (error, response, body) {
            if (response.statusCode == 201) {
              res.send({
                success: true
              });
            } else {
              res.send({
                success: false,
                error: 2,
                error_name: "Spotify error",
                spotify_error_info: body.error
              });
            }
          }
        }, req);
      } else {
        res.send({
          success: false,
          error: 3,
          error_name: 'Invalid or missing access_token'
        });
      }
    });
  } else {
    res.send({
      success: false,
      error: 1,
      error_name: 'Missing or invalid playlist_id or track_uri'
    });
  }
});

app.get('/search_song', function(req, res) {
  function buildQuery(artist, title) {
    var q = '';
    if (artist) {
      q += artist;
      if (title) {
        q += ' ';
      }
    }
    if (title) {
      q += title;
    }

    q = q.toLowerCase();
    q = q.replace(/[\(\)\[\]\<\>]/g, '');             // grouping symbols
    q = q.replace(/\./g, '');                         // dots. spotify searching M.I.A. or MIA works, but M I A doesn't
    q = q.replace(/\bf(ea)?t(uring)?\b/g, '');        // feat/ft/featuring
    q = q.replace(/official( music)?( video)?/g, ''); // youtube tags
    q = q.replace(/\blyric(s)?( video)?\b/g, '');     // lyrics/lyric(s) video
    q = q.replace(/\bh(q|d)\b/g, '');                 // ...
    q = q.replace(/\boriginal mix\b/g, '');           // generally speaking, original mix is a useless identifier
                                                      // radio edit is always specified, and special edits/mixes
                                                      // are differently labeled
    return q;
  }

  var artist = req.query.artist || null;
  var title = req.query.title || null;

  // build query accounting for artist/title being missing
  var q = buildQuery(artist, title);

  if (q) {
    request.get({
      url: 'https://api.spotify.com/v1/search',
      qs: {
        type: 'track',
        market: 'US',
        q: q,
        limit: 10,
        offset: 0
      },
      json: true
    }, function (error, response, body) {
      if (!error && response.statusCode == 200) {
        var tracks = body.tracks.items;
        
        // Find the best-match track from the spotify results
        var minLevenshtein = Infinity;
        var bestTrack = null;
        for (var index = 0; index < tracks.length; index++) {
          var track = tracks[index];

          // Build a list containing each individual artist as well as a string containing all of the track's artists
          var artist_combos = [];
          for (var artistindex = 0; artistindex < track.artists.length; artistindex++) {
            var artist = track.artists[artistindex].name;
            artist_combos.push(artist);
          }
          artist_combos.push(artist_combos.join(' '));

          // Now, run through each element, check how well each matches our desired track (q), and pick the best one
          for (var artistcomboindex = 0; artistcomboindex < artist_combos.length; artistcomboindex++) {
            var artist_combo = artist_combos[artistcomboindex];

            var lev = levenshtein(buildQuery(artist_combo, track.name), q);
            if (lev < minLevenshtein) {
              minLevenshtein = lev;
              bestTrack = track;
            }
          }
        }

        if (!bestTrack || !bestTrack.id) {
          // If we have no best track or an invalid one
          res.send({
            success: false,
            error: 2,
            error_name: "Song not found",
            track: bestTrack
          });
        } else {
          res.send({
            success: true,
            track: bestTrack
          })
        }
      } else {
        res.send({
          success: false,
          error: 3,
          error_name: "Spotify error",
          spotify_error_info: response.body.error
        });
      }
    })
  } else {
    res.send({
      success: false,
      error: 1,
      error_name: "Bad query"
    });
  }
});

console.log('Listening on 8888');
app.listen(process.env.PORT || 8888);
