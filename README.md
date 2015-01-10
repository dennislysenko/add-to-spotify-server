# add-to-spotify-server

Simple Node.js (express) server that interfaces with the Spotify Web API -- see dslysenko/add-to-spotify-chrome for more info

# Setup
You will definitely need to make a Spotify application to get an application client ID and secret: https://developer.spotify.com/my-applications/

Once you've done that, clone this repo and locally create a .env file in the add-to-spotify-server holding the following information (obviously, replace XXXXXX and YYYYYY as appropriate with your Spotify application credentials):

    SPOTIFY_CLIENT_ID=XXXXXX
    SPOTIFY_CLIENT_SECRET=YYYYYY
    CALLBACK_URI=http://localhost:8888/callback

Note: if you change the port that express listens on in `app.js`, change `CALLBACK_URI` to reflect that.

Now add the `CALLBACK_URI` you specified in `.env` to the callbacks in your Spotify application. (Also, if you are planning on hosting an instance publicly, make sure you add another callback with your hostname plus /callback, in the same format as the existing one.)

If you are running redis with default settings (localhost:6379, no auth), the server will work out of the box--otherwise, please specify in .env:

    REDIS_URL=https://your-redis-url

# Footnotes
This was my first stab at a Node.js server and is based on the Spotify Web API Beginner Tutorial.

Why Redis? Easy to set up (one command to install on OS X, or take your pick of the free Redis services on Heroku), fast, and we don't need relational or document storage in such a simple application.
