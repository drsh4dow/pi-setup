export interface SearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
  thumbnail?: FrameData;
  frames?: VideoFrame[];
  duration?: number;
}

export interface SearchResult {
  answer: string;
  sources: SearchSource[];
  content: ExtractedContent[];
}

export interface SearchOptions {
  numResults?: number;
  includeContent?: boolean;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
  signal?: AbortSignal;
}

export interface FetchOptions {
  forceClone?: boolean;
  prompt?: string;
  timestamp?: string;
  frames?: number;
  model?: string;
}

export interface FrameData {
  data: string;
  mimeType: string;
}

export interface VideoFrame extends FrameData {
  timestamp: string;
}

export type FrameResult = FrameData | { error: string };

export interface StoredSearchItem {
  query: string;
  answer: string;
  sources: SearchSource[];
  content: ExtractedContent[];
  error: string | null;
}

export type StoredResponse =
  | {
      id: string;
      type: "search";
      timestamp: number;
      items: StoredSearchItem[];
    }
  | {
      id: string;
      type: "fetch";
      timestamp: number;
      items: ExtractedContent[];
    };
