// Milestone 1 intentionally exposes entitlement status and feature details
// without compiling a purchase rail. StoreKit/RevenueCat arrives in the
// signed release milestone; web payment code must never enter this bundle.
export { default } from '../native-stubs/SubscriptionScreen';

