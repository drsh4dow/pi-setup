// Keep fixture source out of shell syntax, including cmd.exe expansion and quoting.
export function nodeCommand(source: string): string {
	const encoded = Buffer.from(source).toString("base64");
	return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}
