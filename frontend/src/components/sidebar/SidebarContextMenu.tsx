import React from "react";
import { Edit2, Plus, Share2, Trash2 } from "lucide-react";
import type { Collection } from "../../types";
import { useLocale } from "../../context/useLocale";
import { createPortal } from "react-dom";

export type SidebarContextMenuState = {
  x: number;
  y: number;
  type: "item" | "background";
  id?: string;
};

interface SidebarContextMenuProps {
  contextMenu: SidebarContextMenuState;
  collections: Collection[];
  onClose: () => void;
  onCreateCollection: (parentId: string | null) => void;
  onRenameCollection: (collection: Collection) => void;
  onShareCollection: (id: string) => void;
  onDeleteCollection: (id: string) => void;
}

export const SidebarContextMenu: React.FC<SidebarContextMenuProps> = ({
  contextMenu,
  collections,
  onClose,
  onCreateCollection,
  onRenameCollection,
  onShareCollection,
  onDeleteCollection,
}) => {
  const { t } = useLocale();
  return createPortal(
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="ui-menu absolute w-52 animate-in fade-in zoom-in-95 duration-100"
        style={{
          top: Math.max(0, Math.min(contextMenu.y, window.innerHeight - 175)),
          left: Math.max(0, Math.min(contextMenu.x, window.innerWidth - 216)),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {contextMenu.type === "item" && contextMenu.id ? (
          <>
            <button
              onClick={() => {
                onCreateCollection(contextMenu.id!);
                onClose();
              }}
              className="ui-menu-item"
            >
              <Plus size={14} /> {t("sidebar.newSubcollection")}
            </button>
            <button
              onClick={() => {
                onShareCollection(contextMenu.id!);
                onClose();
              }}
              className="ui-menu-item"
            >
              <Share2 size={14} /> Share Collection
            </button>
            <button
              onClick={() => {
                const collection = collections.find(
                  (c) => c.id === contextMenu.id,
                );
                if (collection) onRenameCollection(collection);
                onClose();
              }}
              className="ui-menu-item"
            >
              <Edit2 size={14} /> Rename Collection
            </button>
            <div className="ui-menu-separator" />
            <button
              onClick={() => {
                onDeleteCollection(contextMenu.id!);
                onClose();
              }}
              className="ui-menu-item ui-menu-item-danger"
            >
              <Trash2 size={14} /> Delete Collection
            </button>
          </>
        ) : (
          <button
            onClick={() => {
              onCreateCollection(null);
              onClose();
            }}
            className="ui-menu-item"
          >
            <Plus size={14} /> {t("sidebar.newCollection")}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
};
