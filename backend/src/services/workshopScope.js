'use strict';

const { brand, CONSOLES } = require('../brand');

// Whose work a member of workshop staff may see.
//
// Technicians have always seen every job card and every workshop's diary, and
// on OnFleet that is correct: OnFleet owns the workshops and services every
// fleet's motorcycles at them, so there is one workshop floor and the people
// on it work across all of it.
//
// Pillion is the other shape. A fleet there runs its own workshop, staffed by
// its own mechanics, and "sees everything" would mean one fleet's mechanic
// reading another fleet's bookings, registrations, job cards and costs. It is
// the same leak-through-a-shared-resource the workshop_locations work fixed
// for owners, left open for staff because at the time no fleet could have any.
//
// The rule, which is inert on OnFleet and correct on Pillion:
//
//   a technician with an organisation   is that fleet's, and sees its work
//                                       and nothing else.
//   a technician with none              is the platform's own. On OnFleet
//                                       that is the whole floor, exactly as
//                                       today. On a telematics deployment the
//                                       operator runs no workshop, so there is
//                                       nothing for them to be looking at and
//                                       they are refused — the same boundary
//                                       admins meet.
//
// Every technician in existence today has no organisation, because the admin
// form that creates them has never set one. That is what makes this safe to
// land: on OnFleet it changes nothing at all until somebody deliberately
// attaches a technician to a fleet.

const WORKSHOP_STAFF = ['technician', 'control_room'];
const isTelematics = brand.adminConsole === CONSOLES.TELEMATICS;

/**
 * @returns {{all: true}}                    sees every fleet's work
 *          {{orgId: number}}                sees one fleet's work
 *          {{refuse: {status, error, code}}} has no business here
 */
function workshopScope(req) {
  const role = req.user?.role;
  if (['admin', 'superadmin'].includes(role)) return { all: true };
  if (!WORKSHOP_STAFF.includes(role)) return { all: true };

  const orgId = req.user.organization_id || null;
  if (orgId) return { orgId: Number(orgId) };

  if (isTelematics) {
    return {
      refuse: {
        status: 403,
        error: 'This workshop belongs to a fleet. Only their own staff work in it.',
        code: 'NOT_THIS_CONSOLE',
      },
    };
  }
  return { all: true };
}

/**
 * The scope as SQL against a bike alias, for the lists.
 *
 * A job card hangs on a motorcycle, and the motorcycle is what belongs to a
 * fleet — so this scopes on the bike rather than on the card. fleet_org_id is
 * taken into account because a card raised before a bike was attached to a
 * fleet carries it there instead.
 */
function bikeScopeSql(scope, { bikeAlias = 'b', cardAlias = 'jc', index = 1 } = {}) {
  if (scope.all) return { clause: 'TRUE', params: [] };
  return {
    clause: `COALESCE(${bikeAlias}.organization_id, ${cardAlias}.fleet_org_id) = $${index}`,
    params: [scope.orgId],
  };
}

module.exports = { workshopScope, bikeScopeSql, WORKSHOP_STAFF };
