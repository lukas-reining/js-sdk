import { DefaultLogger, SafeLogger } from './logger';
import { NOOP_TRANSACTION_CONTEXT_PROPAGATOR } from './no-op-transaction-context-propagator';
import {
  CommonProvider,
  EvaluationContext,
  Logger,
  ProviderMetadata,
  TransactionContext,
  TransactionContextPropagator,
} from './types';
import { EventDetails, EventHandler, Eventing, OpenFeatureEventEmitter, ProviderEvents } from './events';
import { objectOrUndefined, stringOrUndefined } from './type-guards';

export abstract class OpenFeatureCommonAPI<P extends CommonProvider = CommonProvider> implements Eventing {
  protected _transactionContextPropagator: TransactionContextPropagator = NOOP_TRANSACTION_CONTEXT_PROPAGATOR;
  protected _context: EvaluationContext = {};
  protected _logger: Logger = new DefaultLogger();

  protected abstract _defaultProvider: P;

  private readonly _events = new OpenFeatureEventEmitter(() => this._logger);
  protected _clientProviders: Map<string, P> = new Map();
  protected _clientEvents: Map<string | undefined, OpenFeatureEventEmitter> = new Map();

  abstract clearHooks(): this;

  setLogger(logger: Logger): this {
    this._logger = new SafeLogger(logger);
    return this;
  }

  /**
   * Get metadata about registered provider.
   * @returns {ProviderMetadata} Provider Metadata
   */
  get providerMetadata(): ProviderMetadata {
    return this._defaultProvider.metadata;
  }

  getContext(): EvaluationContext {
    return this._context;
  }

  /**
   * Adds a handler for the given provider event type.
   * The handlers are called in the order they have been added.
   * When changing the provider, the currently attached handlers will listen to the events of the new provider.
   * @param {ProviderEvents} eventType The provider event type to listen to
   * @param {EventHandler} handler The handler to run on occurrence of the event type
   */
  addHandler(eventType: ProviderEvents, handler: EventHandler): void {
    this._events.addHandler(eventType, handler);
  }

  /**
   * Removes a handler for the given provider event type.
   * @param {ProviderEvents} eventType The provider event type to remove the listener for
   * @param {EventHandler} handler The handler to remove for the provider event type
   */
  removeHandler(eventType: ProviderEvents, handler: EventHandler): void {
    this._events.removeHandler(eventType, handler);
  }

  /**
   * Gets the current handlers for the given provider event type.
   * @param {ProviderEvents} eventType The provider event type to get the current handlers for
   * @returns {EventHandler[]} The handlers currently attached to the given provider event type
   */
  getHandlers(eventType: ProviderEvents): EventHandler[] {
    return this._events.getHandlers(eventType);
  }

  /**
   * Sets the default provider for flag evaluations.
   * This provider will be used by unnamed clients and named clients to which no provider is bound.
   * Setting a provider supersedes the current provider used in new and existing clients without a name.
   * @template P
   * @param {P} provider The provider responsible for flag evaluations.
   * @returns {OpenFeatureCommonAPI} OpenFeature API
   */
  setProvider(provider: P): this;
  /**
   * Sets the provider that OpenFeature will use for flag evaluations of providers with the given name.
   * Setting a provider supersedes the current provider used in new and existing clients with that name.
   * @template P
   * @param {string} clientName The name to identify the client
   * @param {P} provider The provider responsible for flag evaluations.
   * @returns {this} OpenFeature API
   */
  setProvider(clientName: string, provider: P): this;
  setProvider(clientOrProvider?: string | P, providerOrUndefined?: P): this {
    const clientName = stringOrUndefined(clientOrProvider);
    const provider = objectOrUndefined<P>(clientOrProvider) ?? objectOrUndefined<P>(providerOrUndefined);

    if (!provider) {
      return this;
    }

    const oldProvider = this.getProviderForClient(clientName);

    // ignore no-ops
    if (oldProvider === provider) {
      return this;
    }

    const clientEmitter = this.getEventEmitterForClient(clientName);

    if (typeof provider.initialize === 'function') {
      provider
        .initialize?.(this._context)
        ?.then(() => {
          clientEmitter.emit(ProviderEvents.Ready, { clientName });
          this._events?.emit(ProviderEvents.Ready, { clientName });
        })
        ?.catch((error) => {
          clientEmitter.emit(ProviderEvents.Error, { clientName, message: error.message });
          this._events?.emit(ProviderEvents.Error, { clientName, message: error.message });
        });
    } else {
      clientEmitter.emit(ProviderEvents.Ready, { clientName });
      this._events?.emit(ProviderEvents.Ready, { clientName });
    }

    if (clientName) {
      this._clientProviders.set(clientName, provider);
    } else {
      this._defaultProvider = provider;
    }

    this.transferListeners(oldProvider, provider, clientName, clientEmitter);

    // Do not close the default provider if a named client used the default provider
    if (!clientName || (clientName && oldProvider !== this._defaultProvider)) {
      oldProvider?.onClose?.();
    }
    return this;
  }

  protected getProviderForClient(name?: string): P {
    if (!name) {
      return this._defaultProvider;
    }

    return this._clientProviders.get(name) ?? this._defaultProvider;
  }

  protected getEventEmitterForClient(name?: string): OpenFeatureEventEmitter {
    const emitter = this._clientEvents.get(name);

    if (emitter) {
      return emitter;
    }

    const newEmitter = new OpenFeatureEventEmitter(() => this._logger);
    this._clientEvents.set(name, newEmitter);
    return newEmitter;
  }

  private transferListeners(
    oldProvider: P,
    newProvider: P,
    clientName: string | undefined,
    clientEmitter: OpenFeatureEventEmitter
  ) {
    oldProvider.events?.removeAllHandlers();

    // iterate over the event types
    Object.values<ProviderEvents>(ProviderEvents).forEach((eventType) =>
      newProvider.events?.addHandler(eventType, async (details?: EventDetails) => {
        // on each event type, fire the associated handlers
        clientEmitter.emit(eventType, { ...details, clientName });
        this._events.emit(eventType, { ...details, clientName });
      })
    );
  }

  async close(): Promise<void> {
    try {
      await this?._defaultProvider?.onClose?.();
    } catch (err) {
      this.handleShutdownError(this._defaultProvider, err);
    }

    const providers = Array.from(this._clientProviders);

    await Promise.all(
      providers.map(async ([, provider]) => {
        try {
          await provider.onClose?.();
        } catch (err) {
          this.handleShutdownError(this._defaultProvider, err);
        }
      })
    );
  }

  private handleShutdownError(provider: P, err: unknown) {
    this._logger.error(`Error during shutdown of provider ${provider.metadata.name}: ${err}`);
    this._logger.error((err as Error)?.stack);
  }

  setTransactionContextPropagator(transactionContextPropagator: TransactionContextPropagator): OpenFeatureCommonAPI<P> {
    const baseMessage = 'Invalid TransactionContextPropagator, will not be set: ';
    if (typeof transactionContextPropagator?.getTransactionContext !== 'function') {
      this._logger.error(`${baseMessage}: getTransactionContext is not a function.`);
    } else if (typeof transactionContextPropagator?.setTransactionContext !== 'function') {
      this._logger.error(`${baseMessage}: setTransactionContext is not a function.`);
    } else {
      this._transactionContextPropagator = transactionContextPropagator;
    }
    return this;
  }

  setTransactionContext<R>(
    transactionContext: TransactionContext,
    callback: (...args: unknown[]) => R,
    ...args: unknown[]
  ): void {
    this._transactionContextPropagator.setTransactionContext(transactionContext, callback, ...args);
  }

  getTransactionContext(): TransactionContext {
    try {
      return this._transactionContextPropagator.getTransactionContext();
    } catch (err: unknown) {
      const error = err as Error | undefined;
      this._logger.error(`Error getting transaction context: ${error?.message}, returning empty context.`);
      this._logger.error(error?.stack);
      return {};
    }
  }
}
