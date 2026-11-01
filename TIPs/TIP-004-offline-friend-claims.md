# TIP-004: Recording Debts to Friends Not Yet on Tally

| Field   | Value |
|---------|-------|
| Number  | TIP-004 |
| Title   | Recording Debts to Friends Not Yet on Tally |
| Status  | Draft |
| Author  | Jussi Rytkönen |
| Created | 2026-06-02 |

---

## Summary

A user can record a debt they owe to someone who does not yet use Tally. The debtor self-signs a **provisional** debt record that commits to a secret bearer token instead of a recipient public key, and emails a claim link containing that token to the friend. When the friend installs Tally and generates their own keypair, they **bind** their key to the provisional record by revealing the token. On the next time both are online, the debtor verifies the binding and counter-signs to **finalise** the debt as a normal `transaction_created` record.

The scheme needs no temporary keypair, keeps every record cryptographically attributable to a real key, and leaves the debtor in control of finalisation so a leaked or raced token cannot steal the credit.

---

## Motivation

Today a debt can only be recorded against an existing Tally friend, because every `transaction_created` record is signed by the debtor and references the creditor's public key as `to_user_id`. This makes Tally useless for the most common real-world moment: "I owe you, let me note it down" — when the other person isn't on Tally yet.

We want the debtor to be able to commit to the debt **immediately and non-repudiably**, and to invite the friend in via a channel they already have (email), without:

- inventing a throwaway keypair whose private key would have to be shared (defeating the signature), or
- trusting the email/link channel with the integrity of the debt amount, or
- requiring a central server to vouch for anything.

---

## Key Cryptographic Idea

You cannot create a keypair on someone else's behalf and have them later prove sole ownership — sharing the private key destroys the signature's meaning. So instead of pre-creating the creditor's identity, we **defer** binding the creditor identity and use a **hash commitment to a bearer secret** as a placeholder.

- Debtor picks a random secret `s` (high entropy, e.g. 32 bytes).
- The commitment is `h = SHA256(s)`.
- The provisional record references `h` where a normal record would reference the creditor's public key.
- Knowledge of `s` is the bearer capability to claim the credit. `s` travels only in the email link.
- Revealing `s` later lets the claimant prove "this provisional record was meant for me" by attaching their freshly-generated public key to a binding record.

This is the same primitive as an HTLC hashlock or a password-reset token: the holder of the preimage can act, and the commitment is published while the preimage stays secret until claim time.

Because debt records are signed by the **debtor's existing key** (not the creditor's), the debtor never needs a key they don't have. The creditor's key simply doesn't exist yet, and `h` stands in for it until it does.

---

## Structural Properties

**1. Records are only shared between friends.**

In Tally, ledger records are not broadcast to the whole network — they are shared between the two friends a record concerns. This means the binding record (which reveals `s`) is never broadcast; it is encrypted and sent directly to the debtor. There is no need to verify the record against the whole network.

**2. A claim implies a friendship.**

Friendship is currently required before transaction-type records are accepted (the handlers gate on `isAcceptedFriendshipStatus`). Registering from a claim link therefore establishes the friendship **first**, using the existing `friend_request`/`friend_accept` handshake — with the bearer token `s` carried as proof so the debtor auto-accepts without a manual prompt. Only once the friendship is `ACCEPTED` are the binding and final transaction records exchanged.

**3. The debtor is the finaliser.**

The provisional record is binding on the debtor from the moment it is signed. But it only becomes a normal ledger debt once the debtor sees a valid binding and counter-signs. This keeps the debtor in control: a stolen or raced token cannot finalise a debt to the wrong key without the debtor's confirmation.

---

## Record Sequence

The records are produced over the lifetime of one offline claim, in this order:

```
1. claim record         (provisional debt; debtor self-signs; commits to h = SHA256(s))
2. friend request/accept (existing handshake; s carried as proof → debtor auto-accepts)
3. binding record        (claimant signs C_pub to the claim, revealing s)
4. transaction record    (final transaction_created, normal debtor→creditor debt)
```

The claim record is created and stored locally by the debtor at recording time. The friendship is established with the **existing** `friend_request`/`friend_accept` messages — there is no new "friendship record" type. The binding and transaction records follow once the channel exists. The friendship must come before the binding/transaction because the transaction handlers only accept records between `ACCEPTED` friends.

### Placeholder ID for multiple pre-registration claims

The provisional record's recipient field uses a **placeholder ID** derived deterministically from the email address, e.g. `placeholder_id = SHA256(lowercase(trim(email)))`. This lets several debtors send claims to the same email before the friend registers, and lets one debtor send several claims over time, all keyed to the same future identity. When the friend finally registers, every provisional record addressed to that `placeholder_id` rebinds to the same new public key in one pass.

Note: `placeholder_id` (derived from the email, used for grouping/addressing) is distinct from `h = SHA256(s)` (the per-claim bearer commitment, used for authorisation). One placeholder can have many claims, each with its own `s`/`h`.

---

## Protocol

### Phase 1 — Debtor records the debt (offline-capable)

1. Debtor enters amount, note, and the friend's **email address**.
2. Client generates a random secret `s`, computes `h = SHA256(s)` and `placeholder_id = SHA256(normalised_email)`.
3. Client creates and signs the **claim record**:

```
claim_record {
  type:           "offline_claim"
  id:             uuid
  from_user_id:   <debtor pubkey>        // debtor = signer = the one who owes
  placeholder_id: <SHA256(email)>        // who this is for, before they have a key
  commitment:     <h = SHA256(s)>        // bearer commitment
  amount_eur:     <amount>
  note:           <note>
  created_at:     <timestamp>
  signature:      <debtor Schnorr sig over canonical digest of the above>
}
```

   This record is written to the debtor's local ledger immediately. It is binding and non-repudiable: the debtor has signed "I owe `amount` to whoever holds the preimage of `h`." It works fully offline — no server needed at this step.

4. Client sends the **claim email** (see §Email & Delivery) containing:
   - a registration/claim link with `s` and the debtor's **public key** embedded,
   - human-readable amount/note for the recipient to sanity-check.

### Phase 2 — Friend registers and the channel is established

Friendship is required before any transaction-type record will be accepted (the existing inbound/outbound transaction handlers gate on `isAcceptedFriendshipStatus`). So Phase 2 establishes the friendship **first**, reusing the existing friend-request/accept handshake rather than inventing a new "friendship record". The bearer token doubles as proof that lets the debtor auto-accept without a manual prompt.

5. Friend opens the link, installs/opens Tally, and generates their own keypair `C` (public `C_pub`).
6. From the link the client knows `s` and the **debtor's public key**. It sends the debtor an ordinary `MessageType.FRIEND_REQUEST`, ECDH-encrypted to the debtor's key, carrying `s` as proof that a claim already binds them:

```
friend_request {
  type:           "friend_request"
  from_user_id:   <C_pub>                // the freshly generated creditor key
  to_user_id:     <debtor pubkey>
  payload: {
    requester_name: <claimant name>
    claim_proof:    <s>                   // preimage of a claim's commitment
  }
  signature:      <claimant Schnorr sig over canonical digest>
}
```

   Encryption needs only the debtor's public key (pure ECDH), which the email provided — no prior relationship is required to send this.

7. The debtor receives the request and, in `applyInboundFriendRequest`, adds a branch: look up a local `claim_record` whose `commitment === SHA256(claim_proof)`. If one is found, **auto-accept** the friendship (emit `MessageType.FRIEND_ACCEPT`) with no user prompt — analogous to the existing cross-request (`PENDING_OUTGOING`) and ECDH-recovery auto-accept paths. The debtor notes which `claim_record` this `C_pub` is now associated with. If no claim matches the proof, fall back to the normal manual friend-request flow.

   Matching is by **commitment, not identity**: the claimant's key is brand new and unknown to the debtor, so `SHA256(s) === claim.commitment` is the join key that ties the request to the right provisional claim.

8. Both sides now have an `ACCEPTED` friendship and an encrypted channel over the normal transport (relay server or WebRTC).

### Phase 3 — Binding and finalisation

9. With the friendship established, the claimant sends the signed **binding record**:

```
binding_record {
  type:          "offline_claim_binding"
  id:            uuid
  from_user_id:  <C_pub>                 // claimant signs as the new creditor
  to_user_id:    <debtor pubkey>
  claim_id:      <id of the original claim_record>
  secret:        <s>                     // preimage; proves the right to claim
  created_at:    <timestamp>
  signature:     <claimant Schnorr sig over canonical digest of the above>
}
```

   The binding is the claimant's non-repudiable "I, `C_pub`, claim this debt via `s`." It protects the *claimant*: without it the debtor would be unilaterally assigning their own debt to a key.

10. The debtor verifies:
    - `SHA256(binding.secret) == claim.commitment` (correct preimage), and
    - the binding's signature verifies against `from_user_id` (`C_pub`), and
    - the referenced `claim_record` exists, is the debtor's own, and is not already finalised.
11. If valid, the debtor creates the final **transaction record** — a normal `transaction_created` from debtor (`from_user_id`) to creditor (`to_user_id = C_pub`) for the committed amount, counter-signed by the debtor. It is indistinguishable from a debt that was always between two Tally friends, and passes the `isAcceptedFriendshipStatus` gate because the friendship from Phase 2 is in place.
12. The provisional `claim_record` is marked finalised (linked to the transaction id) so it cannot be replayed.

After Phase 3 the debt is a first-class ledger entry between two friends, and the bearer token is spent.

> **Note on when `s` is revealed.** Because `s` rides in the `friend_request`, the debtor learns it at Phase 2 (one step earlier than a binding-first design). That is fine — the debtor is the intended holder of `s` — but it means the bearer-token race is resolved at the friend-request step rather than at binding. The separate signed `binding_record` still earns its place for the claimant's non-repudiation.

---

## Why the Debtor Must Finalise (Bearer Token Safety)

The secret `s` is a **pure bearer token**: anyone who holds it can present a binding. The risk the user raised: if `s` leaked (e.g. forwarded email, malicious relay), an attacker could connect to the debtor first and bind their own key, stealing the credit.

Mitigation is **debtor confirmation on sync** rather than auto-acceptance:

- The binding does not by itself move money. It is a *request* to finalise. The debtor's client decides whether to counter-sign.
- The debtor should be shown the claim ("Someone claimed your €X note to alice@example.com") and, where the original recipient is known/trusted, can confirm before finalising. For low-friction cases the first valid binding can auto-finalise, but the **debtor's** signature is always the gate.
- Because the debtor is the single finaliser, a race or leak cannot produce a finalised debt the debtor didn't approve.

This is a deliberate trade-off: the bearer token keeps the email flow simple, and debtor-side finalisation contains the bearer token's inherent "whoever holds it can claim" weakness.

---

## Encryption Flow (clarified)

- The **claim record** (debtor → placeholder) cannot be ECDH-encrypted to the recipient, because at creation time the recipient has no key. It stays in the debtor's local ledger and the only thing that leaves the device is the email link carrying `s` + the debtor's public key.
- Once the claimant registers, **both public keys are known to the claimant**. ECDH encryption needs only the recipient's public key, so the claimant can encrypt the `friend_request` (and later the `binding` record) to the debtor straight away — no prior relationship is required at the crypto layer. Both travel over the normal relay/WebRTC channel. There is no plaintext-over-email of any signed record — email carries only the bearer token and the debtor's (public) key.
- The friendship-first rule is an **application-layer** constraint (transaction handlers reject records from non-`ACCEPTED` friends), not a cryptographic one. The `friend_request`/`friend_accept` handshake satisfies that constraint before the binding is sent.

---

## Email & Delivery

This feature requires an email server to send claim links. Tally does not currently have one.

To preserve decentralisation, the email server **must not** be hard-coded:

- Add a new user setting: **email relay address** (the endpoint Tally posts the claim email to).
- It defaults to a Tally-operated server for convenience but can be changed to any compatible endpoint the user runs or trusts.
- The setting lives with the other user-configurable infrastructure settings (cf. relay/signaling server configuration in TIP-003), so a self-hoster can point every external dependency at their own infrastructure.

The email server only relays a message; it never sees `s` in a form that lets it claim (it transmits the link but is not a Tally participant and cannot counter-sign as the debtor). Still, treat the email channel as untrusted for confidentiality — the security model relies on debtor-side finalisation, not on the email server being honest.

---

## Validation Rules

A claim-proving **`friend_request`** triggers auto-accept only if:

1. The request carries a `claim_proof` and `SHA256(claim_proof)` matches the `commitment` of some local `claim_record` signed by this debtor that is not already finalised.

Otherwise the request falls back to the normal manual friend-request flow.

A **`binding_record`** is accepted by the debtor only if:

1. `SHA256(binding.secret) == claim.commitment`.
2. `binding.signature` verifies against `binding.from_user_id` (`C_pub`).
3. The sender is now an `ACCEPTED` friend (established by Phase 2).
4. The referenced `claim_record` exists in the debtor's ledger, was signed by the debtor, and is not already finalised.

The final `transaction_created` is then created and signed by the debtor following the existing transaction rules. The claim record is marked finalised and linked to the transaction id to prevent replay.

---

## Open Questions

1. **Auto-finalise vs. confirm.** Should the first valid binding auto-finalise, or always prompt the debtor? Probably auto-finalise for v1 with a notification, prompt as a setting.
2. **Claim expiry.** Should `claim_record`s expire if unclaimed for N days, reducing the window a leaked token is useful? An expiry timestamp in the claim record is cheap to add.
3. **Revocation.** Can a debtor revoke an unclaimed claim (e.g. paid in cash instead)? A signed `offline_claim_revoked` record referencing `claim_id` would let the ledger reflect it; bindings after revocation are rejected.
4. **Multiple bindings / first-wins.** With a pure bearer token, two parties could both present `s`. First valid binding the debtor counter-signs wins; later ones are rejected because the claim is finalised. Confirm this is the desired resolution.
5. **Email verification of amount.** The recipient sees the amount in the email and can dispute before claiming, but has no cryptographic say in the amount (the debtor sets it). Acceptable, since the debtor is the one taking on the obligation.
6. **Placeholder collisions / email change.** If the friend registers with a different email than the claim was sent to, rebinding by `placeholder_id` won't match automatically; the bearer token still works via the link, so the link is the authoritative path and `placeholder_id` is only an optimisation for grouping.

---

## Implementation Notes

- New ledger record types: `offline_claim`, `offline_claim_binding`. (Possibly `offline_claim_revoked` per Open Q3.)
- **Reuse**, do not replace, the existing friendship handshake (`MessageType.FRIEND_REQUEST` / `MessageType.FRIEND_ACCEPT`). No new "friendship record" type.
- New command (analogous to `createTransaction`): `createOfflineClaim({ email, amount, note })` — generates `s`, computes `h` and `placeholder_id`, signs and stores the claim record, triggers the email.
- Claim-link handler on registration: parse `s` + debtor pubkey; send a `friend_request` carrying `claim_proof: s` (ECDH-encrypted to the debtor); on `friend_accept`, send the signed `binding_record`; all over normal peer transport.
- New branch in `applyInboundFriendRequest` (`peer/handlers.js`): if `payload.claim_proof` hashes to the `commitment` of a local unfinalised `claim_record`, **auto-accept** (mirror the existing `PENDING_OUTGOING` cross-request and ECDH-recovery auto-accept paths) and remember the claim↔`C_pub` association.
- New handler case in `peer/handlers.js`: apply incoming `offline_claim_binding` (debtor side) → verify preimage + signature + `ACCEPTED` friendship → create final `transaction_created` and mark the claim finalised.
- New user setting: **email relay address**, alongside existing infra settings (see TIP-003), changeable by the user.
- Reuse existing signing primitives in `peer/envelope.js` (`signInnerMessage`, `verifyInnerSignature`, `digestForSigning`) for the new record types.
- Requires an email-sending server (does not exist yet) addressed by the configurable setting above.
