export interface ApiTeam {
  id: number;
  name: string;
  accomodation: string;
  street: string;
  housenumber: number;
  housenumber_addition: string;
  postcode: string;
  city: string;
  lat: string;
  long: string;
  area: string | null;
}

export interface ApiArea {
  name: string;
  status: string;
  updated_at: string;
}

/** A row of the logged-in /hunts page of jotihunt.nl */
export interface WebHunt {
  area: string;
  /** Normalised (whitespace removed); null for hunts without a code (QR flow since 16 Oct 2026) */
  huntCode: string | null;
  status: string;
  points: number;
  /** The time as shown on the site */
  huntTime: string;
  /** huntTime parsed (server local time); null when not recognised */
  time: Date | null;
}

export interface ApiArticle {
  id: number;
  title: string;
  type: string;
  publish_at: string;
  message: {
    content: string;
    type: string;
    max_points: number;
    end_time: string;
  };
}
