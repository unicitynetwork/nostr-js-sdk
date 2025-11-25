/**
 * Filter - Nostr subscription filter (NIP-01).
 * Provides a builder pattern for constructing filters.
 */

/**
 * Filter data structure for Nostr subscriptions.
 */
export interface FilterData {
  /** Event IDs to match */
  ids?: string[];

  /** Author public keys to match */
  authors?: string[];

  /** Event kinds to match */
  kinds?: number[];

  /** Events referenced by "e" tags */
  '#e'?: string[];

  /** Public keys referenced by "p" tags */
  '#p'?: string[];

  /** Topics/hashtags referenced by "t" tags */
  '#t'?: string[];

  /** Identifiers for parameterized replaceable events ("d" tags) */
  '#d'?: string[];

  /** Minimum timestamp (inclusive, Unix seconds) */
  since?: number;

  /** Maximum timestamp (inclusive, Unix seconds) */
  until?: number;

  /** Maximum number of events to return */
  limit?: number;
}

/**
 * Filter class for Nostr subscription queries.
 * Use the builder pattern to construct filters.
 */
export class Filter implements FilterData {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#e'?: string[];
  '#p'?: string[];
  '#t'?: string[];
  '#d'?: string[];
  since?: number;
  until?: number;
  limit?: number;

  /**
   * Create a Filter instance.
   * @param data Optional filter data
   */
  constructor(data?: FilterData) {
    if (data) {
      if (data.ids) this.ids = [...data.ids];
      if (data.authors) this.authors = [...data.authors];
      if (data.kinds) this.kinds = [...data.kinds];
      if (data['#e']) this['#e'] = [...data['#e']];
      if (data['#p']) this['#p'] = [...data['#p']];
      if (data['#t']) this['#t'] = [...data['#t']];
      if (data['#d']) this['#d'] = [...data['#d']];
      if (data.since !== undefined) this.since = data.since;
      if (data.until !== undefined) this.until = data.until;
      if (data.limit !== undefined) this.limit = data.limit;
    }
  }

  /**
   * Create a new Filter builder.
   * @returns Filter builder instance
   */
  static builder(): FilterBuilder {
    return new FilterBuilder();
  }

  /**
   * Convert the filter to a plain object for JSON serialization.
   * Only includes defined properties.
   * @returns Plain object representation
   */
  toJSON(): FilterData {
    const result: FilterData = {};

    if (this.ids && this.ids.length > 0) result.ids = this.ids;
    if (this.authors && this.authors.length > 0) result.authors = this.authors;
    if (this.kinds && this.kinds.length > 0) result.kinds = this.kinds;
    if (this['#e'] && this['#e'].length > 0) result['#e'] = this['#e'];
    if (this['#p'] && this['#p'].length > 0) result['#p'] = this['#p'];
    if (this['#t'] && this['#t'].length > 0) result['#t'] = this['#t'];
    if (this['#d'] && this['#d'].length > 0) result['#d'] = this['#d'];
    if (this.since !== undefined) result.since = this.since;
    if (this.until !== undefined) result.until = this.until;
    if (this.limit !== undefined) result.limit = this.limit;

    return result;
  }

  /**
   * Parse a filter from JSON data.
   * @param json JSON object or string
   * @returns Filter instance
   */
  static fromJSON(json: unknown): Filter {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    return new Filter(data as FilterData);
  }
}

/**
 * Builder class for constructing Filter instances.
 */
export class FilterBuilder {
  private data: FilterData = {};

  /**
   * Set event IDs to match.
   * @param ids Event IDs (variadic or array)
   * @returns This builder for chaining
   */
  ids(...ids: string[]): FilterBuilder;
  ids(ids: string[]): FilterBuilder;
  ids(idsOrFirst: string | string[], ...rest: string[]): FilterBuilder {
    if (Array.isArray(idsOrFirst)) {
      this.data.ids = [...idsOrFirst];
    } else {
      this.data.ids = [idsOrFirst, ...rest];
    }
    return this;
  }

  /**
   * Set author public keys to match.
   * @param authors Author public keys (variadic or array)
   * @returns This builder for chaining
   */
  authors(...authors: string[]): FilterBuilder;
  authors(authors: string[]): FilterBuilder;
  authors(authorsOrFirst: string | string[], ...rest: string[]): FilterBuilder {
    if (Array.isArray(authorsOrFirst)) {
      this.data.authors = [...authorsOrFirst];
    } else {
      this.data.authors = [authorsOrFirst, ...rest];
    }
    return this;
  }

  /**
   * Set event kinds to match.
   * @param kinds Event kinds (variadic or array)
   * @returns This builder for chaining
   */
  kinds(...kinds: number[]): FilterBuilder;
  kinds(kinds: number[]): FilterBuilder;
  kinds(kindsOrFirst: number | number[], ...rest: number[]): FilterBuilder {
    if (Array.isArray(kindsOrFirst)) {
      this.data.kinds = [...kindsOrFirst];
    } else {
      this.data.kinds = [kindsOrFirst, ...rest];
    }
    return this;
  }

  /**
   * Set "e" tags to match (event references).
   * @param eTags Event IDs referenced by "e" tags (variadic or array)
   * @returns This builder for chaining
   */
  eTags(...eTags: string[]): FilterBuilder;
  eTags(eTags: string[]): FilterBuilder;
  eTags(eTagsOrFirst: string | string[], ...rest: string[]): FilterBuilder {
    if (Array.isArray(eTagsOrFirst)) {
      this.data['#e'] = [...eTagsOrFirst];
    } else {
      this.data['#e'] = [eTagsOrFirst, ...rest];
    }
    return this;
  }

  /**
   * Set "p" tags to match (pubkey references).
   * @param pTags Public keys referenced by "p" tags (variadic or array)
   * @returns This builder for chaining
   */
  pTags(...pTags: string[]): FilterBuilder;
  pTags(pTags: string[]): FilterBuilder;
  pTags(pTagsOrFirst: string | string[], ...rest: string[]): FilterBuilder {
    if (Array.isArray(pTagsOrFirst)) {
      this.data['#p'] = [...pTagsOrFirst];
    } else {
      this.data['#p'] = [pTagsOrFirst, ...rest];
    }
    return this;
  }

  /**
   * Set "t" tags to match (topics/hashtags).
   * @param tTags Topics referenced by "t" tags (variadic or array)
   * @returns This builder for chaining
   */
  tTags(...tTags: string[]): FilterBuilder;
  tTags(tTags: string[]): FilterBuilder;
  tTags(tTagsOrFirst: string | string[], ...rest: string[]): FilterBuilder {
    if (Array.isArray(tTagsOrFirst)) {
      this.data['#t'] = [...tTagsOrFirst];
    } else {
      this.data['#t'] = [tTagsOrFirst, ...rest];
    }
    return this;
  }

  /**
   * Set "d" tags to match (parameterized replaceable identifiers).
   * @param dTags Identifiers referenced by "d" tags (variadic or array)
   * @returns This builder for chaining
   */
  dTags(...dTags: string[]): FilterBuilder;
  dTags(dTags: string[]): FilterBuilder;
  dTags(dTagsOrFirst: string | string[], ...rest: string[]): FilterBuilder {
    if (Array.isArray(dTagsOrFirst)) {
      this.data['#d'] = [...dTagsOrFirst];
    } else {
      this.data['#d'] = [dTagsOrFirst, ...rest];
    }
    return this;
  }

  /**
   * Set minimum timestamp (inclusive).
   * @param since Unix timestamp in seconds
   * @returns This builder for chaining
   */
  since(since: number): FilterBuilder {
    this.data.since = since;
    return this;
  }

  /**
   * Set maximum timestamp (inclusive).
   * @param until Unix timestamp in seconds
   * @returns This builder for chaining
   */
  until(until: number): FilterBuilder {
    this.data.until = until;
    return this;
  }

  /**
   * Set maximum number of events to return.
   * @param limit Maximum number of events
   * @returns This builder for chaining
   */
  limit(limit: number): FilterBuilder {
    this.data.limit = limit;
    return this;
  }

  /**
   * Build the Filter instance.
   * @returns Filter instance
   */
  build(): Filter {
    return new Filter(this.data);
  }
}
