"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BYOK_CHANGE_EVENT,
  BYOK_STORAGE_KEY,
  clearLocalByok,
  type LocalByok,
  readLocalByok,
  writeLocalByok,
} from "./storage";

export function useLocalByok() {
  const [byok, setByok] = useState<LocalByok | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setByok(readLocalByok());
    setReady(true);

    const handleByokChange = () => {
      setByok(readLocalByok());
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === BYOK_STORAGE_KEY) {
        setByok(readLocalByok());
      }
    };

    window.addEventListener(BYOK_CHANGE_EVENT, handleByokChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(BYOK_CHANGE_EVENT, handleByokChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const save = useCallback((value: LocalByok) => {
    const next = writeLocalByok(value);
    setByok(readLocalByok());
    return next;
  }, []);

  const clear = useCallback(() => {
    clearLocalByok();
    setByok(null);
  }, []);

  return { byok, ready, save, clear };
}
