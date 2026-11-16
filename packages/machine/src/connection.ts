/**
 * What the gate answered for one connection.
 *
 * @remarks
 * `admitted` means this connection is the current one. `stale` means a newer
 * connection has taken over, and carries the highest seq seen so far so the
 * caller can report it.
 */
export type Admission =
  | { readonly kind: "admitted" }
  | { readonly kind: "stale"; readonly floor: number };

/**
 * Refuses the older of two connections that both claim the machine, by seq.
 *
 * @remarks
 * `seq` names a connection instance and is assigned when the connection is
 * established; it does not change per request, so a retry on the same
 * connection is admitted. A request from a connection with a lower seq than the
 * highest one seen is the older connection and is refused, which is how a
 * reconnect after a tunnel restart wins over the connection Cloudflare has not
 * torn down yet. A different connection claiming the same seq is not newer and
 * is refused too, so two connections cannot both be current.
 */
export class ConnectionGate {
  #floor = 0;
  #current: string | undefined;

  /** The highest seq this gate has admitted. */
  get floor(): number {
    return this.#floor;
  }

  /**
   * Decide whether a connection may act.
   *
   * @param connection - The connection instance's id, from the request header.
   * @param seq - A positive safe integer naming the connection instance.
   * @returns `admitted` for a newer seq or the current connection's own seq;
   * `stale` with the floor otherwise.
   */
  admit(connection: string, seq: number): Admission {
    if (!Number.isSafeInteger(seq) || seq < 1) {
      return { kind: "stale", floor: this.#floor };
    }
    if (seq < this.#floor) return { kind: "stale", floor: this.#floor };
    if (seq === this.#floor) {
      return this.#current === connection
        ? { kind: "admitted" }
        : { kind: "stale", floor: this.#floor };
    }
    this.#floor = seq;
    this.#current = connection;
    return { kind: "admitted" };
  }
}
