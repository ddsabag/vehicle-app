// one real run of the weekly settlements watch (next's settlements.mjs), output in out/ (inspect publishes it); no Telegram secrets here
import {execFileSync} from "node:child_process";
process.stdout.write(execFileSync("node", [".github/scripts/settlements.mjs", "watch"], {env: {...process.env, OUT: "out", TELEGRAM_BOT_TOKEN: ""}, encoding: "utf8"}));
