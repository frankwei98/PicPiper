import type { AppView } from "../types";

export interface GalleryFocus {
  profileId?: string;
  prefix: string;
  highlightedKeys: string[];
}

export interface AppNavigationState {
  view: AppView;
  galleryFocus: GalleryFocus;
}

export const initialNavigationState: AppNavigationState = {
  view: "optimize",
  galleryFocus: {
    prefix: "",
    highlightedKeys: [],
  },
};
