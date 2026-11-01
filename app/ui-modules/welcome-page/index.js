/*
This module binds the first-run welcome screen. It validates the initial username, optionally accepts an existing NIP-49 (ncryptsec + passphrase) login, handles submit state, and delegates user creation to the app shell callback.

Login uses NIP-49 exclusively: the user pastes the encoded key (`ncryptsec1...`) produced by another device's "Transfer" flow (or any other Nostr client that exports the same format) together with the passphrase set during that export. The passphrase is never transmitted; it is combined with the encoded key locally to recover the private key via scrypt + XChaCha20-Poly1305.
@category ui
*/

import { initCheckToggle } from "../components/check-toggle.js";
import { isValidNcryptsec } from "../../js/crypto/nip49.js";
import { isNip07Available } from "../../js/crypto/key-provider.js";

/**
 * @param {any} root
 * @param {{ onCreateUser?: Function }} [options]
 */
export const bindWelcome = (root, { onCreateUser } = {}) => {
  const formElement = root.querySelector('[data-form="welcome"]');
  const nameInput = root.querySelector('[data-bind="welcome-name"]');
  const errorElement = root.querySelector('[data-bind="welcome-error"]');
  const createButton = root.querySelector('[data-action="create-user"]');
  const toggleButton = root.querySelector('[data-bind="existing-key-toggle"]');
  const keyPanel = root.querySelector('[data-section="existing-key-panel"]');
  const passphraseInput = root.querySelector('[data-bind="login-passphrase-input"]');
  const ncryptsecInput = root.querySelector('[data-bind="login-ncryptsec-input"]');
  const nip07Panel = root.querySelector('[data-section="nip07-panel"]');
  const nip07Button = root.querySelector('[data-action="create-user-nip07"]');

  if (!formElement || !nameInput || !createButton || typeof onCreateUser !== "function") {
    return;
  }

  // The extension option is only meaningful when a NIP-07 signer is installed.
  if (nip07Panel && isNip07Available()) {
    nip07Panel.hidden = false;
  }

  const toggle = initCheckToggle(toggleButton, {
    checked: false,
    onChange: (isChecked) => {
      if (keyPanel) keyPanel.hidden = !isChecked;
      createButton.textContent = isChecked ? "Login" : "Create a user";
      if (isChecked && passphraseInput) {
        setTimeout(() => passphraseInput.focus(), 0);
      }
    },
  });

  const setError = (message) => {
    if (!errorElement) return;
    if (!message) {
      errorElement.textContent = "";
      errorElement.hidden = true;
      return;
    }

    errorElement.textContent = message;
    errorElement.hidden = false;
  };

  const setBusy = (isBusy) => {
    createButton.disabled = isBusy;
    const isLogin = toggle.isChecked();
    createButton.textContent = isBusy
      ? isLogin ? "Logging in..." : "Creating user..."
      : isLogin ? "Login" : "Create a user";
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");

    const enteredName = nameInput.value.trim();
    const isLogin = toggle.isChecked();

    if (!isLogin && !enteredName) {
      setError("Please choose a name before continuing.");
      nameInput.focus();
      return;
    }

    let loginOptions = null;
    if (isLogin) {
      const passphrase = passphraseInput ? passphraseInput.value : "";
      const ncryptsec = ncryptsecInput ? ncryptsecInput.value.trim() : "";

      if (!passphrase) {
        setError("Please enter your passphrase.");
        if (passphraseInput) passphraseInput.focus();
        return;
      }
      if (!ncryptsec) {
        setError("Please paste your encoded key.");
        if (ncryptsecInput) ncryptsecInput.focus();
        return;
      }
      if (!isValidNcryptsec(ncryptsec)) {
        setError("Invalid encoded key. Expected format: ncryptsec1...");
        if (ncryptsecInput) ncryptsecInput.focus();
        return;
      }
      loginOptions = { ncryptsec, passphrase };
    }

    try {
      setBusy(true);
      // scrypt blocks for ~1s — yield a frame so the "Logging in..." label paints.
      if (isLogin) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      await onCreateUser(enteredName, loginOptions || {});
    } catch (error) {
      if (isLogin && /passphrase/i.test(String(error?.message || ""))) {
        setError("Incorrect passphrase.");
      } else if (isLogin) {
        setError("Could not log in. Check your passphrase and encoded key.");
      } else {
        setError("Could not create user. Please try again.");
      }
      setBusy(false);
    }
  };

  formElement.addEventListener("submit", (event) => {
    void handleSubmit(event);
  });

  // NIP-07: hand off to the extension. The name is optional here — an existing
  // Nostr identity may already carry a name via synced history; if blank we fall
  // back to the npub. The extension prompts the user to approve key access.
  if (nip07Button) {
    nip07Button.addEventListener("click", async () => {
      setError("");
      const enteredName = nameInput.value.trim();
      const previousLabel = nip07Button.textContent;
      try {
        createButton.disabled = true;
        nip07Button.disabled = true;
        nip07Button.textContent = "Waiting for extension...";
        await onCreateUser(enteredName, { useNip07: true });
      } catch (error) {
        setError(
          /denied|reject/i.test(String(error?.message || ""))
            ? "The extension request was declined."
            : "Could not connect to your signer extension. Please try again."
        );
        createButton.disabled = false;
        nip07Button.disabled = false;
        nip07Button.textContent = previousLabel;
      }
    });
  }

  setTimeout(() => {
    nameInput.focus();
  }, 0);
};
