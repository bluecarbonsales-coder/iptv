'use strict';

// Production credentials must be injected through the runtime environment.
// Never commit TMDB/OMDb API keys into the repository or container image.
module.exports = Object.freeze({
  TMDB_API_KEY: process.env.TMDB_API_KEY || '',
  OMDB_API_KEY: process.env.OMDB_API_KEY || '',
});
