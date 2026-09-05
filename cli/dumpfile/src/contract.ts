export const BUCKET_NAME = "dumpfile-prod";
export const PUBLIC_BASE_URL = "https://files.drsh4dow.dev";
export const CACHE_CONTROL = "no-store";
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const SIGNATURE_TTL_SECONDS = 300;

const inlineContentTypes: ReadonlySet<string> = new Set([
	"application/pdf",
	"audio/flac",
	"audio/mp4",
	"audio/mpeg",
	"audio/ogg",
	"audio/wav",
	"image/avif",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
	"text/plain",
	"video/mp4",
	"video/quicktime",
	"video/webm",
]);

const extensionContentTypes: Readonly<Record<string, string>> = {
	avif: "image/avif",
	flac: "audio/flac",
	gif: "image/gif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	log: "text/plain",
	m4a: "audio/mp4",
	mov: "video/quicktime",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	ogg: "audio/ogg",
	pdf: "application/pdf",
	png: "image/png",
	txt: "text/plain",
	wav: "audio/wav",
	webm: "video/webm",
	webp: "image/webp",
};

export type StoredDisposition = "attachment" | "inline";

export interface UploadAuthorizationRequest {
	readonly contentType: string;
	readonly extension: string;
	readonly size: number;
}

export interface UploadHeaders {
	readonly "Cache-Control": string;
	readonly "Content-Disposition": StoredDisposition;
	readonly "Content-Length": string;
	readonly "Content-Type": string;
}

export interface UploadAuthorization {
	readonly key: string;
	readonly publicUrl: string;
	readonly upload: {
		readonly expiresAt: string;
		readonly headers: UploadHeaders;
		readonly method: "PUT";
		readonly url: string;
	};
}

export function contentTypeForExtension(extension: string): string {
	return extensionContentTypes[extension] ?? "application/octet-stream";
}

export function dispositionForContentType(
	contentType: string,
): StoredDisposition {
	return inlineContentTypes.has(contentType) ? "inline" : "attachment";
}
