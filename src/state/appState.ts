import type { AppView, S3Profile } from "../types";

export interface GalleryFocus {
  profile?: S3Profile;
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
