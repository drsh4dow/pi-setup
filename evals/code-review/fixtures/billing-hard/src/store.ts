import type { Invoice } from "./invoices.ts";
import type { Subscription } from "./subscriptions.ts";
import type { WebhookEndpoint } from "./webhooks.ts";

/** In-memory storage for the service. Saving replaces the stored record with the same id. */
export class BillingStore {
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #invoices = new Map<string, Invoice>();
  readonly #endpoints = new Map<string, WebhookEndpoint>();
  #lastInvoiceNumber = 0;

  getSubscription(id: string): Subscription | undefined {
    return this.#subscriptions.get(id);
  }

  saveSubscription(subscription: Subscription): void {
    this.#subscriptions.set(subscription.id, subscription);
  }

  /** Returns every subscription, oldest first. */
  subscriptions(): Subscription[] {
    return [...this.#subscriptions.values()];
  }

  getInvoice(id: string): Invoice | undefined {
    return this.#invoices.get(id);
  }

  saveInvoice(invoice: Invoice): void {
    this.#invoices.set(invoice.id, invoice);
  }

  /** Returns a subscription's invoices, oldest first. */
  invoicesFor(subscriptionId: string): Invoice[] {
    return [...this.#invoices.values()].filter((invoice) => invoice.subscriptionId === subscriptionId);
  }

  /**
   * Takes the next invoice sequence number. Only finalization calls this: a taken number is
   * never handed out again, so taking one for an invoice that isn't finalized leaves a gap.
   */
  takeInvoiceNumber(): number {
    this.#lastInvoiceNumber += 1;
    return this.#lastInvoiceNumber;
  }

  getEndpoint(id: string): WebhookEndpoint | undefined {
    return this.#endpoints.get(id);
  }

  saveEndpoint(endpoint: WebhookEndpoint): void {
    this.#endpoints.set(endpoint.id, endpoint);
  }

  deleteEndpoint(id: string): boolean {
    return this.#endpoints.delete(id);
  }

  /** Returns every webhook endpoint, oldest first. */
  endpoints(): WebhookEndpoint[] {
    return [...this.#endpoints.values()];
  }
}
