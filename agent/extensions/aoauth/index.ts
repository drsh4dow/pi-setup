import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { anthropicOAuth } from "./oauth.ts";

export default function aoauthExtension(pi: ExtensionAPI) {
	pi.registerProvider("anthropic", { oauth: anthropicOAuth });
}
