import { type Static, Type } from "typebox";

export const BUCKET_NAME = "dumpfile-prod";

export const PUBLIC_BASE_URL = "https://files.drsh4dow.dev";

export const CACHE_CONTROL = "no-store";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export const SIGNATURE_TTL_SECONDS = 300;

const extensionContentTypes: ReadonlyMap<string, string> = new Map([
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
]);

const inlineContentTypes: ReadonlySet<string> = new Set(
	extensionContentTypes.values(),
);

export const uploadRequestSchema = Type.Object(
	{
		size: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		contentType: Type.String({
			pattern:
				"^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$",
		}),
		extension: Type.Union([
			Type.Literal(""),
			Type.String({ pattern: "^[a-z0-9]{1,16}$" }),
		]),
	},
	{ additionalProperties: false },
);

const uploadHeadersSchema = Type.ReadonlyObject(
	Type.Object({
		"Cache-Control": Type.String(),
		"Content-Disposition": Type.Union([
			Type.Literal("attachment"),
			Type.Literal("inline"),
		]),
		"Content-Length": Type.String({ pattern: "^\\d+$" }),
		"Content-Type": Type.String(),
	}),
	{ additionalProperties: false },
);

export const uploadAuthorizationSchema = Type.Object({
	key: Type.String({
		pattern: "^\\d{4}/\\d{2}/\\d{2}/[a-f0-9]{32}(?:\\.[a-z0-9]{1,16})?$",
	}),
	publicUrl: Type.String(),
	upload: Type.ReadonlyObject(
		Type.Object({
			expiresAt: Type.String(),
			headers: uploadHeadersSchema,
			method: Type.Literal("PUT"),
			url: Type.String(),
		}),
	),
});

export type UploadAuthorizationRequest = Readonly<
	Static<typeof uploadRequestSchema>
>;

export type UploadHeaders = Static<typeof uploadHeadersSchema>;

export type UploadAuthorization = Readonly<
	Static<typeof uploadAuthorizationSchema>
>;

export type StoredDisposition = UploadHeaders["Content-Disposition"];

export function contentTypeForExtension(extension: string): string {
	return extensionContentTypes.get(extension) ?? "application/octet-stream";
}

export function dispositionForContentType(
	contentType: string,
): StoredDisposition {
	return inlineContentTypes.has(contentType) ? "inline" : "attachment";
}
