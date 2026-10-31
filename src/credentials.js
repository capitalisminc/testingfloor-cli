import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const CREDENTIALS_FILE = "credentials.json";

// The folder `testingfloor login` saves its token in: TESTING_FLOOR_CONFIG_DIR
// when it's set, otherwise the per-user config folder for the platform.
export function credentialsDirectory(env = process.env, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (env.TESTING_FLOOR_CONFIG_DIR) {
    return paths.resolve(env.TESTING_FLOOR_CONFIG_DIR);
  }

  if (platform === "win32") {
    return paths.join(env.APPDATA || paths.join(os.homedir(), "AppData", "Roaming"), "testingfloor");
  }

  return paths.join(env.XDG_CONFIG_HOME || paths.join(os.homedir(), ".config"), "testingfloor");
}

export function credentialsPath(env = process.env, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.join(credentialsDirectory(env, platform), CREDENTIALS_FILE);
}

// The saved login, or null when no one is signed in. A saved login is
// { apiUrl, token, user: { name, email }, createdAt }, and its token is only
// for the API URL it was issued by.
export async function readSavedLogin(env = process.env) {
  const file = credentialsPath(env);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new Error(`Couldn't read the saved login at ${file}: ${error.message}`);
  }

  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    saved = null;
  }
  if (typeof saved?.token !== "string" || typeof saved?.apiUrl !== "string") {
    throw new Error(`The saved login at ${file} is damaged. Run "testingfloor logout", then "testingfloor login".`);
  }

  return saved;
}

// Only the current user can read the file. It's written to a temporary file
// and renamed into place, so a reader never sees half a file.
export async function saveLogin(env, login) {
  const directory = credentialsDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const file = path.join(directory, CREDENTIALS_FILE);
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  return file;
}

// Returns whether there was a saved login to delete.
export async function deleteSavedLogin(env = process.env) {
  try {
    await unlink(credentialsPath(env));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
