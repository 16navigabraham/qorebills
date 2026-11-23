import fs from "node:fs";
import path from "node:path";

/** A small JSON file for what the agent must remember across restarts (the account address). */
export function createStateStore(file) {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    get: () => ({ ...state }),
    set(patch) {
      state = { ...state, ...patch };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, file);
    },
  };
}

/** In-memory store for tests. */
export function memoryState(initial = {}) {
  let state = { ...initial };
  return { get: () => ({ ...state }), set: (patch) => void (state = { ...state, ...patch }) };
}
