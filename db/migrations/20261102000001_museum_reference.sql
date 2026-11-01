-- migrate:up
-- P1a (A§7.2, A§8): the reference data the museum table points at. The two
-- extensions are trusted, and mjk_migrator owns the database. P1b's search uses
-- them; they are created here so the one migration role owns them from the start.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE province (
  code text PRIMARY KEY CHECK (code ~ '^NL-[A-Z]{2}$'),
  name_nl text NOT NULL CHECK (char_length(name_nl) BETWEEN 1 AND 100),
  name_en text NOT NULL CHECK (char_length(name_en) BETWEEN 1 AND 100)
);

INSERT INTO province (code, name_nl, name_en) VALUES
  ('NL-DR', 'Drenthe', 'Drenthe'),
  ('NL-FL', 'Flevoland', 'Flevoland'),
  ('NL-FR', 'Fryslân', 'Friesland'),
  ('NL-GE', 'Gelderland', 'Gelderland'),
  ('NL-GR', 'Groningen', 'Groningen'),
  ('NL-LI', 'Limburg', 'Limburg'),
  ('NL-NB', 'Noord-Brabant', 'North Brabant'),
  ('NL-NH', 'Noord-Holland', 'North Holland'),
  ('NL-OV', 'Overijssel', 'Overijssel'),
  ('NL-UT', 'Utrecht', 'Utrecht'),
  ('NL-ZE', 'Zeeland', 'Zeeland'),
  ('NL-ZH', 'Zuid-Holland', 'South Holland');

-- Filled by the sync from the Wikidata answer. A municipality may lack its province there.
CREATE TABLE municipality (
  cbs_code text PRIMARY KEY CHECK (cbs_code ~ '^GM[0-9]{4}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  province_code text REFERENCES province (code)
);

-- Grants (A§8: each phase grants its own tables). No DELETE, TRUNCATE, REFERENCES or TRIGGER for any login.
GRANT SELECT ON province TO mjk_worker, mjk_api;
GRANT SELECT, INSERT, UPDATE ON municipality TO mjk_worker;
GRANT SELECT ON municipality TO mjk_api;

-- migrate:down
DROP TABLE municipality;
DROP TABLE province;
DROP EXTENSION unaccent;
DROP EXTENSION pg_trgm;
