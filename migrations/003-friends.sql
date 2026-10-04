CREATE TABLE player_profiles (
 user_id TEXT PRIMARY KEY REFERENCES user(id),
 friend_code TEXT NOT NULL UNIQUE CHECK(length(friend_code)=8)
);
CREATE TABLE relationships (
 id TEXT PRIMARY KEY,
 user_a TEXT NOT NULL REFERENCES user(id),
 user_b TEXT NOT NULL REFERENCES user(id),
 requester TEXT NOT NULL REFERENCES user(id),
 status TEXT NOT NULL CHECK(status IN ('PENDING','ACCEPTED','DECLINED','CANCELLED','REMOVED')),
 revision INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL,
 UNIQUE(user_a,user_b), CHECK(user_a < user_b),
 CHECK(requester=user_a OR requester=user_b)
);
CREATE INDEX relationship_b ON relationships(user_b,status);
CREATE INDEX relationship_a ON relationships(user_a,status);
