import { useRef, useCallback } from "react";

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

declare global {
  interface Window {
    webkitSpeechRecognition: new () => SpeechRecognitionInstance;
    SpeechRecognition: new () => SpeechRecognitionInstance;
  }
}

interface UseSpeechRecognitionOptions {
  onResult: (transcript: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
}

interface UseSpeechRecognitionReturn {
  start: () => void;
  stop: () => void;
  isSupported: boolean;
}

export function useSpeechRecognition({
  onResult,
  onError,
}: UseSpeechRecognitionOptions): UseSpeechRecognitionReturn {
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  const isSupported =
    typeof window !== "undefined" &&
    ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);

  const start = useCallback(() => {
    if (!isSupported) {
      onError?.("このブラウザは音声認識に対応していません");
      return;
    }

    const SpeechRecognitionClass =
      window.webkitSpeechRecognition || window.SpeechRecognition;
    const recognition = new SpeechRecognitionClass();

    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "ja-JP";
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        // Use best alternative (index 0) for display/logging
        const bestTranscript = result[0].transcript;
        onResult(bestTranscript, result.isFinal);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "not-allowed") {
        onError?.("マイクへのアクセスが拒否されました");
      } else if (event.error === "no-speech") {
        // 無音は無視
      } else {
        onError?.(`音声認識エラー: ${event.error}`);
      }
    };

    recognition.onend = () => {
      // continuous=true でも切れることがあるので再起動
      if (recognitionRef.current) {
        try {
          recognition.start();
        } catch {
          // already started
        }
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch {
      onError?.("音声認識の開始に失敗しました");
    }
  }, [isSupported, onResult, onError]);

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
  }, []);

  return { start, stop, isSupported };
}
