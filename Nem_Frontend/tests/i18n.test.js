import test from "node:test";
import assert from "node:assert/strict";

// Create a mock localStorage to test language preference without using a real browser.
const makeLocalStorage = () => {
  const store = {};
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
    removeItem(key) {
      delete store[key];
    },
  };
};

// Verify that English is selected by default when no language preference is saved.
test("defaults to English when no language preference is stored", async () => {
  const storage = makeLocalStorage();
  globalThis.localStorage = storage;

  const { getPreferredLanguage, normalizeLanguage } = await import("../src/i18n/index.js");

  assert.equal(getPreferredLanguage(), "en");
  assert.equal(normalizeLanguage("fr"), "en");
});

// Verify that the selected language is saved and restored from localStorage.
test("persisted language preference is remembered and re-used", async () => {
  const storage = makeLocalStorage();
  globalThis.localStorage = storage;

  const { setPreferredLanguage, getPreferredLanguage } = await import("../src/i18n/index.js");

  assert.equal(setPreferredLanguage("hi"), "hi");
  assert.equal(getPreferredLanguage(), "hi");
  assert.equal(storage.getItem("nem-language"), "hi");
});