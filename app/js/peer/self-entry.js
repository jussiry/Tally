/*
Appends a signed ledger entry addressed to the user itself. Such entries are
never queued to anyone: self-sync already copies new ledger entries to the
user's other devices, which is all they are for (notification choices, deleted
history, records waiting to be claimed).
@category network
*/

import { signTallyMessage } from "./authorship.js";
import { createKeyProviderFromState } from "../crypto/key-provider.js";
import { appendLedgerEntryFromMessage } from "../ledger.js";
import { createPeerMessageModel } from "../models/data-model.js";
import { createId } from "../state-utils.js";

export const appendSelfLedgerEntry = async (state, type, payload) => {
  const unsigned = createPeerMessageModel({
    id: createId("peer"),
    type,
    from_user_id: state.user.id,
    to_user_id: state.user.id,
    created_at: new Date().toISOString(),
    payload,
  });
  const keyProvider = createKeyProviderFromState(state);
  let authorship = null;
  if (keyProvider) {
    try {
      authorship = await signTallyMessage(unsigned, keyProvider);
    } catch {
      authorship = null;
    }
  }
  appendLedgerEntryFromMessage(state, { ...unsigned, authorship });
};
