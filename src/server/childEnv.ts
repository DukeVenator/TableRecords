/**
 * Build a child-process environment without inheriting secrets.
 *
 * Discord/dashboard tokens live in the server process only. Python needs a
 * normal Windows environment and CUDA paths, but never the bot token.
 */
const SAFE_KEYS = [
  "PATH",
  "Path",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "CUDA_PATH",
  "CUDA_HOME",
  "CUDA_VISIBLE_DEVICES",
  "NVIDIA_VISIBLE_DEVICES",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "VIRTUAL_ENV",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONIOENCODING",
  "PYTHONUNBUFFERED",
  "HF_HOME",
  "HF_HUB_OFFLINE",
  "TRANSFORMERS_OFFLINE"
];

export function sanitizedChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (!env.PATH && process.env.Path) env.PATH = process.env.Path;
  return { ...env, ...extra };
}
