import { useEffect, useState } from "react";
import throttle from "lodash/throttle";

type UseEditorChromeOptions = {
  drawingName: string;
  autoHideEnabled: boolean;
  isRenaming: boolean;
  isShareOpen: boolean;
};

export const useEditorChrome = ({
  drawingName,
  autoHideEnabled,
  isRenaming,
  isShareOpen,
}: UseEditorChromeOptions) => {
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);

  useEffect(() => {
    document.title = `${drawingName} - ExcaliDash`;
    return () => {
      document.title = "ExcaliDash";
    };
  }, [drawingName]);

  useEffect(() => {
    if (!autoHideEnabled || isRenaming || isShareOpen) {
      setIsHeaderVisible(true);
      return;
    }

    let hideTimeout: ReturnType<typeof setTimeout> | null = null;
    let isInHeader = false;
    const scheduleHide = () => {
      if (hideTimeout !== null) clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        setIsHeaderVisible(false);
        hideTimeout = null;
      }, 2000);
    };

    const handleMouseMove = throttle((event: MouseEvent) => {
      if (event.clientY < 5) setIsHeaderVisible(true);
      const isOverHeader =
        event.target instanceof Element &&
        event.target.closest("[data-editor-header]") !== null;
      const keepVisible = event.clientY < 5 || isOverHeader;
      if (keepVisible) {
        if (hideTimeout !== null) clearTimeout(hideTimeout);
        hideTimeout = null;
      } else if (isInHeader) {
        scheduleHide();
      }
      isInHeader = keepVisible;
    }, 100);

    setIsHeaderVisible(true);
    scheduleHide();

    window.addEventListener("mousemove", handleMouseMove, { passive: true });

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      handleMouseMove.cancel();
      if (hideTimeout !== null) clearTimeout(hideTimeout);
    };
  }, [autoHideEnabled, isRenaming, isShareOpen]);

  return {
    isHeaderVisible,
    setIsHeaderVisible,
  };
};
