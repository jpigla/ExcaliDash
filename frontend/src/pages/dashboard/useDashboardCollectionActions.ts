import React from "react";
import * as api from "../../api";
import type { Collection } from "../../types";

type UseDashboardCollectionActionsParams = {
  selectedCollectionId: string | null | undefined;
  setSelectedCollectionId: (id: string | null | undefined) => void;
  setCollections: React.Dispatch<React.SetStateAction<Collection[]>>;
  refreshData: () => void;
};

export const useDashboardCollectionActions = ({
  selectedCollectionId,
  setSelectedCollectionId,
  setCollections,
  refreshData,
}: UseDashboardCollectionActionsParams) => {
  const handleCreateCollection = async (
    name: string,
    parentId: string | null,
  ) => {
    const collection = await api.createCollection(name, parentId);
    setCollections((current) => [
      collection,
      ...current.filter((item) => item.id !== collection.id),
    ]);
  };

  const handleEditCollection = async (id: string, name: string) => {
    setCollections((current) =>
      current.map((collection) =>
        collection.id === id ? { ...collection, name } : collection,
      ),
    );
    try {
      await api.updateCollection(id, name);
    } catch (err) {
      console.error("Failed to rename collection:", err);
      refreshData();
    }
  };

  const handleDeleteCollection = async (id: string) => {
    try {
      await api.deleteCollection(id);
      setCollections((current) =>
        current
          .filter((collection) => collection.id !== id)
          .map((collection) =>
            collection.parentId === id
              ? { ...collection, parentId: null }
              : collection,
          ),
      );
      if (selectedCollectionId === id) setSelectedCollectionId(undefined);
      refreshData();
    } catch (err) {
      console.error("Failed to delete collection:", err);
      refreshData();
    }
  };

  return {
    handleCreateCollection,
    handleEditCollection,
    handleDeleteCollection,
  };
};
