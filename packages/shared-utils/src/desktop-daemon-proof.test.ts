import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDesktopDaemonProof,
  isDesktopDaemonChallenge,
  isDesktopDaemonProofScope,
  verifyDesktopDaemonProof,
} from "./desktop-daemon-proof";

describe("desktop daemon proof", () => {
  const challenge = "ab".repeat(32);

  it("creates a deterministic HMAC proof without exposing the token", () => {
    const proof = createDesktopDaemonProof("secret-token", challenge, "operator", 4_100);

    assert.match(proof, /^[a-f0-9]{64}$/);
    assert.equal(proof.includes("secret-token"), false);
    assert.equal(
      createDesktopDaemonProof("secret-token", challenge, "operator", 4_100),
      proof
    );
  });

  it("binds the proof to the token, challenge, scope, and daemon port", () => {
    const proof = createDesktopDaemonProof("secret-token", challenge, "operator", 4_100);

    assert.equal(
      verifyDesktopDaemonProof("secret-token", challenge, "operator", 4_100, proof),
      true
    );
    assert.equal(
      verifyDesktopDaemonProof("wrong-token", challenge, "operator", 4_100, proof),
      false
    );
    assert.equal(
      verifyDesktopDaemonProof("secret-token", "cd".repeat(32), "operator", 4_100, proof),
      false
    );
    assert.equal(
      verifyDesktopDaemonProof("secret-token", challenge, "admin", 4_100, proof),
      false
    );
    assert.equal(
      verifyDesktopDaemonProof("secret-token", challenge, "operator", 5_100, proof),
      false
    );
    assert.equal(
      verifyDesktopDaemonProof("secret-token", challenge, "operator", 4_100, "not-a-proof"),
      false
    );
  });

  it("rejects malformed challenges", () => {
    assert.equal(isDesktopDaemonChallenge(challenge), true);
    assert.equal(isDesktopDaemonChallenge("AB".repeat(32)), false);
    assert.equal(isDesktopDaemonProofScope("operator"), true);
    assert.equal(isDesktopDaemonProofScope("root"), false);
    assert.throws(
      () => createDesktopDaemonProof("secret-token", "short", "operator", 4_100),
      /challenge, scope, and valid port/
    );
  });
});
