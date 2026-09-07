import assert from "node:assert/strict";
import test from "node:test";
import {
	contentTypeForExtension,
	dispositionForContentType,
} from "../src/contract.ts";

test("supported extensions render inline and other media types download", () => {
	const formats: Array<[string, string]> = [
		["avif", "image/avif"],
		["flac", "audio/flac"],
		["gif", "image/gif"],
		["jpeg", "image/jpeg"],
		["jpg", "image/jpeg"],
		["log", "text/plain"],
		["m4a", "audio/mp4"],
		["mov", "video/quicktime"],
		["mp3", "audio/mpeg"],
		["mp4", "video/mp4"],
		["ogg", "audio/ogg"],
		["pdf", "application/pdf"],
		["png", "image/png"],
		["txt", "text/plain"],
		["wav", "audio/wav"],
		["webm", "video/webm"],
		["webp", "image/webp"],
	];
	for (const [extension, contentType] of formats) {
		assert.equal(contentTypeForExtension(extension), contentType);
		assert.equal(dispositionForContentType(contentType), "inline");
	}
	for (const extension of [
		"",
		"html",
		"svg",
		"zip",
		"xyzzy",
		"constructor",
		"toString",
		"__proto__",
	])
		assert.equal(
			contentTypeForExtension(extension),
			"application/octet-stream",
		);
	for (const contentType of [
		"application/octet-stream",
		"text/html",
		"image/svg+xml",
		"application/zip",
	])
		assert.equal(dispositionForContentType(contentType), "attachment");
});
