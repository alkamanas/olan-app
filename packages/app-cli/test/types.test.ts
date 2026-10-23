// @vitest-environment node
// Keeps the hand-written public types (`types/testing.d.ts`, what apps see) in step with the
// implementation (`src/testing`). The checks are type-level: `tsc --noEmit -p .` enforces them.
import { expectTypeOf, it } from 'vitest';

import type * as Impl from '../src/testing';
import type * as Public from '../types/testing';

it('exposes the same option, method and fixture names as the implementation', () => {
  expectTypeOf<keyof Public.RenderAppOptions>().toEqualTypeOf<keyof Impl.RenderAppOptions>();
  expectTypeOf<keyof Public.RenderedApp>().toEqualTypeOf<keyof Impl.RenderedApp>();
  expectTypeOf<keyof Public.MockUi>().toEqualTypeOf<keyof Impl.MockUi>();
  expectTypeOf<keyof Public.Fixtures>().toEqualTypeOf<keyof Impl.Fixtures>();
  expectTypeOf<keyof Public.MockHost>().toEqualTypeOf<keyof Impl.MockHost>();
  expectTypeOf<keyof Public.MockCall>().toEqualTypeOf<keyof Impl.MockCall>();
  expectTypeOf<keyof Public.HttpFixture>().toEqualTypeOf<keyof Impl.HttpFixture>();
  expectTypeOf<Public.NavigationRecord>().toEqualTypeOf<Impl.NavigationRecord>();
  expectTypeOf<keyof Public.FixtureUser>().toEqualTypeOf<keyof Impl.FixtureUser>();
  expectTypeOf<keyof Public.NormalizedFixtures>().toEqualTypeOf<keyof Impl.NormalizedFixtures>();
  expectTypeOf<keyof Public.MockHostOptions>().toEqualTypeOf<keyof Impl.MockHostOptions>();
  expectTypeOf<keyof Public.MockCard>().toEqualTypeOf<keyof Impl.MockCard>();
  expectTypeOf<keyof Public.FixtureCalendar>().toEqualTypeOf<keyof Impl.FixtureCalendar>();
  expectTypeOf<keyof Public.FixtureCalendarEvent>().toEqualTypeOf<keyof Impl.FixtureCalendarEvent>();
  expectTypeOf<keyof Public.FixtureContact>().toEqualTypeOf<keyof Impl.FixtureContact>();
  expectTypeOf<keyof Public.FixtureAddressBook>().toEqualTypeOf<keyof Impl.FixtureAddressBook>();
  expectTypeOf<keyof Public.FixtureMailMessage>().toEqualTypeOf<keyof Impl.FixtureMailMessage>();
  expectTypeOf<keyof Public.FixtureMeeting>().toEqualTypeOf<keyof Impl.FixtureMeeting>();
  expectTypeOf<keyof Public.BackendHarnessOptions>().toEqualTypeOf<keyof Impl.BackendHarnessOptions>();
  expectTypeOf<keyof Public.BackendHarness>().toEqualTypeOf<keyof Impl.BackendHarness>();
  expectTypeOf<keyof Public.BackendResult>().toEqualTypeOf<keyof Impl.BackendResult>();
  expectTypeOf<keyof Public.HookResult>().toEqualTypeOf<keyof Impl.HookResult>();
  expectTypeOf<keyof Public.HookInput>().toEqualTypeOf<keyof Impl.HookInput>();
  expectTypeOf<keyof Public.EmitInput>().toEqualTypeOf<keyof Impl.EmitInput>();
  expectTypeOf<Public.Surface>().toEqualTypeOf<Impl.RenderAppOptions['surface'] & string>();
  expectTypeOf<keyof Public.MockUpload>().toEqualTypeOf<keyof Impl.MockUpload>();
  expectTypeOf<keyof Public.MockUploadAnswer>().toEqualTypeOf<keyof Impl.MockUploadAnswer>();
  expectTypeOf<Public.MockUpload['file']['content']>().toEqualTypeOf<Impl.MockUpload['file']['content']>();
  expectTypeOf<Public.MockUploadAnswer['headers']>().toEqualTypeOf<Record<string, string> | undefined>();
  expectTypeOf<NonNullable<Public.MockCall['error']>>().toEqualTypeOf<{ code: string; message: string; details?: Public.JsonValue }>();
  expectTypeOf<keyof Public.TestIssuer>().toEqualTypeOf<keyof Impl.TestIssuer>();
  expectTypeOf<keyof Public.TestIssuerOptions>().toEqualTypeOf<keyof Impl.TestIssuerOptions>();
  expectTypeOf<keyof Public.RemoteRequestSignInput>().toEqualTypeOf<keyof Impl.RemoteRequestSignInput>();
  expectTypeOf<keyof Public.RemoteRequestSignOptions>().toEqualTypeOf<keyof Impl.RemoteRequestSignOptions>();
  expectTypeOf<keyof Public.SignedRemoteRequest>().toEqualTypeOf<keyof Impl.SignedRemoteRequest>();
  // Phase 6 (second wave) fixtures and live data.
  expectTypeOf<keyof Public.FixtureProjectApp>().toEqualTypeOf<keyof Impl.FixtureProjectApp>();
  expectTypeOf<keyof Public.FixtureProjectStatus>().toEqualTypeOf<keyof Impl.FixtureProjectStatus>();
  expectTypeOf<keyof Public.FixtureProjectLabel>().toEqualTypeOf<keyof Impl.FixtureProjectLabel>();
  expectTypeOf<keyof Public.FixtureProjectField>().toEqualTypeOf<keyof Impl.FixtureProjectField>();
  expectTypeOf<keyof Public.FixtureFieldValues>().toEqualTypeOf<keyof Impl.FixtureFieldValues>();
  expectTypeOf<keyof Public.FixtureIssue>().toEqualTypeOf<keyof Impl.FixtureIssue>();
  expectTypeOf<keyof Public.FixtureRecordLink>().toEqualTypeOf<keyof Impl.FixtureRecordLink>();
  expectTypeOf<keyof Public.FixtureCalendarItem>().toEqualTypeOf<keyof Impl.FixtureCalendarItem>();
  expectTypeOf<keyof Public.FixtureApproval>().toEqualTypeOf<keyof Impl.FixtureApproval>();
  expectTypeOf<Public.MockProjectIssue>().toEqualTypeOf<Impl.MockProjectIssue>();
  expectTypeOf<keyof Public.MockProjectActivity>().toEqualTypeOf<keyof Impl.MockProjectActivity>();
  expectTypeOf<Public.MockProjectActivity['type']>().toEqualTypeOf<Impl.MockProjectActivity['type']>();
});
