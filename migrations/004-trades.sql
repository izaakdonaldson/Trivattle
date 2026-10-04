CREATE TABLE trades (
 id TEXT PRIMARY KEY,
 user_a TEXT NOT NULL REFERENCES user(id),
 user_b TEXT NOT NULL REFERENCES user(id),
 state TEXT NOT NULL CHECK(state IN ('INVITED','NEGOTIATING','SETTLING','COMPLETED','CANCELLED','EXPIRED')),
 revision INTEGER NOT NULL DEFAULT 0,
 offer_revision INTEGER NOT NULL DEFAULT 0,
 a_confirm INTEGER, b_confirm INTEGER,
 a_session TEXT, b_session TEXT,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER,
 error TEXT, CHECK(user_a <> user_b)
);
CREATE INDEX trades_a ON trades(user_a,state,created_at);
CREATE INDEX trades_b ON trades(user_b,state,created_at);
CREATE INDEX trade_expiry ON trades(state,expires_at);
CREATE TABLE trade_offers (
 trade_id TEXT NOT NULL REFERENCES trades(id),
 user_id TEXT NOT NULL REFERENCES user(id),
 instance_id TEXT NOT NULL REFERENCES owned_cards(id),
 version_id TEXT NOT NULL,
 position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 4),
 PRIMARY KEY(trade_id,instance_id), UNIQUE(trade_id,user_id,position)
);
CREATE TABLE trade_reservations (
 instance_id TEXT PRIMARY KEY REFERENCES owned_cards(id),
 trade_id TEXT NOT NULL REFERENCES trades(id)
);
CREATE INDEX reservations_trade ON trade_reservations(trade_id);
CREATE TABLE trade_requests (
 user_id TEXT NOT NULL REFERENCES user(id),
 request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 trade_id TEXT NOT NULL REFERENCES trades(id),
 PRIMARY KEY(user_id,request_id)
);
CREATE TABLE trade_transfers (
 trade_id TEXT NOT NULL REFERENCES trades(id),
 instance_id TEXT NOT NULL REFERENCES owned_cards(id),
 version_id TEXT NOT NULL,
 from_user TEXT NOT NULL REFERENCES user(id),
 to_user TEXT NOT NULL REFERENCES user(id),
 offer_revision INTEGER NOT NULL,
 completed_at INTEGER NOT NULL,
 PRIMARY KEY(trade_id,instance_id)
);
