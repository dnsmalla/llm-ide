// Type-only (never bundled). A server contract change that breaks the System page's
// snapshot type fails `tsc` here, not at runtime in the Mac app.
import type { OsSnapshot } from '@dnsmalla/graph-kit-web';
import type { GetKbOsStateResponse200 } from '../../../extension/src/lib/api-types';

type Assert<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

export type ServerStateIsOsSnapshot = Assert<Assignable<GetKbOsStateResponse200, OsSnapshot>>;
