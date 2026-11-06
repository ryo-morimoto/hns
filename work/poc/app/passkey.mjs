// WebAuthn: registration and login, with a server-side session.
import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

export function createPasskey({ control, rpName = "hns", sessionTtlMs = 30 * 24 * 3600_000 }) {
  const challenges = new Map();
  const setChallenge = (login, challenge) => challenges.set(login, { challenge, expires: Date.now() + 5 * 60_000 });
  const takeChallenge = (login) => {
    const hit = challenges.get(login);
    challenges.delete(login);
    return hit && hit.expires > Date.now() ? hit.challenge : undefined;
  };

  return {
    async registrationOptions({ login, rpID }) {
      const user = control.getUserByLogin(login);
      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: login,
        userID: new TextEncoder().encode(user?.id ?? randomUUID()),
        attestationType: "none",
        excludeCredentials: (user ? control.listCredentials(user.id) : []).map((row) => ({
          id: row.id,
          transports: JSON.parse(row.transports ?? "[]"),
        })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      setChallenge(login, options.challenge);
      return options;
    },

    async verifyRegistration({ login, response, origin, rpID }) {
      const expectedChallenge = takeChallenge(login);
      if (!expectedChallenge) throw new Error("no registration challenge");
      const verification = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID });
      if (!verification.verified || !verification.registrationInfo) return { verified: false };
      const credential = verification.registrationInfo.credential;
      const user = control.getUserByLogin(login) ?? control.createUser(login);
      control.addCredential({
        id: credential.id,
        userId: user.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports,
      });
      return { verified: true, user };
    },

    async authenticationOptions({ login, rpID }) {
      const user = control.getUserByLogin(login);
      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: (user ? control.listCredentials(user.id) : []).map((row) => ({
          id: row.id,
          transports: JSON.parse(row.transports ?? "[]"),
        })),
        userVerification: "preferred",
      });
      setChallenge(login, options.challenge);
      return options;
    },

    async verifyAuthentication({ login, response, origin, rpID }) {
      const expectedChallenge = takeChallenge(login);
      if (!expectedChallenge) throw new Error("no login challenge");
      const row = control.getCredential(response.id);
      if (!row) return { verified: false };
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: { id: row.id, publicKey: Buffer.from(row.public_key, "base64url"), counter: row.counter },
      });
      if (!verification.verified) return { verified: false };
      control.updateCounter(row.id, verification.authenticationInfo.newCounter);
      const user = control.getUserByLogin(login);
      const session = control.createSession(user.id, sessionTtlMs);
      return { verified: true, user, session };
    },
  };
}
