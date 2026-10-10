-- Which source filled a search_cache row: the Data API ('youtube-api') or the results-page
-- fallback ('unofficial'). Rows written before this migration came from the API. 'cards' keeps
-- the results-page snapshot (title, channel, thumbnail, length, live) of unofficial rows, so a
-- cache hit can show them without a network call; it is NULL for API rows.
ALTER TABLE search_cache ADD COLUMN provider TEXT NOT NULL DEFAULT 'youtube-api';
ALTER TABLE search_cache ADD COLUMN cards TEXT;
