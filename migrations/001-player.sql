CREATE TABLE inventory (user_id TEXT PRIMARY KEY REFERENCES user(id), packs INTEGER NOT NULL DEFAULT 0 CHECK(packs >= 0));
CREATE TABLE acquisitions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), source TEXT NOT NULL, acquired_at TEXT NOT NULL);
CREATE TABLE owned_cards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), version_id TEXT NOT NULL, acquired_at TEXT NOT NULL, source TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES acquisitions(id));
CREATE INDEX owned_owner_date ON owned_cards(user_id, acquired_at, id);
CREATE INDEX owned_owner_version ON owned_cards(user_id, version_id);
CREATE TABLE starter_grants (user_id TEXT PRIMARY KEY REFERENCES user(id), event_id TEXT NOT NULL REFERENCES acquisitions(id));
CREATE TABLE pack_openings (id TEXT PRIMARY KEY REFERENCES acquisitions(id), user_id TEXT NOT NULL REFERENCES user(id), request_key TEXT NOT NULL, weights TEXT NOT NULL, UNIQUE(user_id, request_key));
CREATE TABLE pack_rewards (opening_id TEXT NOT NULL REFERENCES pack_openings(id), draw_slot INTEGER NOT NULL, reveal_slot INTEGER NOT NULL, instance_id TEXT NOT NULL UNIQUE REFERENCES owned_cards(id), PRIMARY KEY(opening_id, draw_slot), UNIQUE(opening_id, reveal_slot));
