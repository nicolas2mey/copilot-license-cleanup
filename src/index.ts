import * as core from '@actions/core';
import * as github from '@actions/github';
import momemt from 'moment';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import * as artifact from '@actions/artifact';
import type { Endpoints } from "@octokit/types";
import { SummaryTableRow } from '@actions/core/lib/summary';
import { RequestError } from '@octokit/request-error';

interface Input {
  token: string;
  org: string;
  enterprise: string;
  removeInactive: boolean;
  removefromTeam: boolean;
  inactiveDays: number;
  jobSummary: boolean;
  csv: boolean;
  deployUsers: boolean;
  deployUsersCsv: string;
  deployValidationTime: number;
}

type SeatWithOrg = { 
  last_activity_at: string | null; 
  created_at: string; 
  organization: string; 
  assignee: { login: string; avatar_url: string; }; 
  last_activity_editor: string | null; 
};

// Needed to pass the Octokit type from @actions/github to other functions
type Octokit = ReturnType<typeof github.getOctokit>;

// Create a Map to store data per organization
let orgData = new Map();  // Map<org, { seats: [], inactiveSeats: [] }>

// Function to get all seats in an organization
// Returns an array of seats 
async function getOrgData(org: string, octokit: Octokit) {
  const seats = await core.group('Fetching GitHub Copilot seats for ' + org, async () => {

    // No type exists for copilot endpoint yet
    let _seats: Endpoints["GET /orgs/{org}/copilot/billing/seats"]["response"]['data']['seats'] = [], totalSeats = 0, page = 1;
    do {
      try {
        const response = await octokit.request(`GET /orgs/{org}/copilot/billing/seats?per_page=100&page=${page}`, {
          org: org
        });
        totalSeats = response.data.total_seats;
        _seats = _seats.concat(response.data.seats);
        page++;
      } catch (error) {
        if (error instanceof RequestError && error.message === "Copilot Business is not enabled for this organization.") {
          core.error((error as Error).message + ` (${org})`);
          break;
        } else if (error instanceof RequestError && error.status === 404) {
          core.error((error as Error).message + ` (${org}).  Please ensure that the organization has GitHub Copilot enabled and you are an org owner.`);
          break;
        } else {
          throw error;
        }
      }
    } while (_seats.length < totalSeats);
    core.info(`Found ${_seats.length} seats`)
    core.info(JSON.stringify(_seats, null, 2));
    return _seats;
  });

  // Save seat data to the orgData Map by org id and then return seats
  orgData.set(org, { seats: seats });
  return seats;

}

function getInactiveSeats(org: string, seats, inactiveDays: number) {
  const msToDays = (d) => Math.ceil(d / (1000 * 3600 * 24));

  const now = new Date();
  const inactiveSeats = seats.filter(seat => {
    if (seat.last_activity_at === null || seat.last_activity_at === undefined) {
      const created = new Date(seat.created_at);
      const diff = now.getTime() - created.getTime();
      return msToDays(diff) > inactiveDays;
    }
    const lastActive = new Date(seat.last_activity_at);
    const diff = now.getTime() - lastActive.getTime();
    return msToDays(diff) > inactiveDays;
  }).sort((a, b) => (
    a.last_activity_at === null || a.last_activity_at === undefined || b.last_activity_at === null || b.last_activity_at === undefined ?
    -1 : new Date(a.last_activity_at).getTime() - new Date(b.last_activity_at).getTime()
  ));

  core.info(`Found ${inactiveSeats.length} inactive seats`);

  const inactiveSeatsWithOrg = inactiveSeats.map(seat => ({ ...seat, organization: org } as SeatWithOrg));

  // Save inactive seat data to the orgData map and return inactive seats
  const orgDataEntry = orgData.get(org) || {};
  orgData.set(org, { ...orgDataEntry, inactiveSeats: inactiveSeatsWithOrg });

  return inactiveSeatsWithOrg;

}

export function getInputs(): Input {
  const result = {} as Input;
  result.token = core.getInput('github-token');
  result.org = core.getInput('organization');
  result.enterprise = core.getInput('enterprise');
  result.removeInactive = core.getBooleanInput('remove');
  result.removefromTeam = core.getBooleanInput('remove-from-team');
  result.inactiveDays = parseInt(core.getInput('inactive-days'));
  result.jobSummary = core.getBooleanInput('job-summary');
  result.csv = core.getBooleanInput('csv');
  result.deployUsers = core.getBooleanInput('deploy-users');
  result.deployUsersCsv = core.getInput('deploy-users-csv');
  result.deployValidationTime = parseInt(core.getInput('deploy-validation-time'));
  return result;
}

const run = async (): Promise<void> => {
  const input = getInputs();
  let organizations: string[] = [];
  let hasNextPage = false;
  let afterCursor: string | undefined = undefined;
  /*
  type SeatWithOrg = { 
    last_activity_at: string | null; 
    created_at: string; 
    organization: string; 
    assignee: { login: string; avatar_url: string; }; 
    last_activity_editor: string | null; 
  };
  */
  let allInactiveSeats: SeatWithOrg[] = [];
  let allRemovedSeatsCount = 0;
  let allSeatsCount = 0;

  const octokit = github.getOctokit(input.token);

  if (input.enterprise && input.enterprise !== null) {
    core.info(`Fetching all organizations for ${input.enterprise}...`);

    // Fetch all organizations in the enterprise
    interface GraphQlResponse {
      enterprise: {
        organizations: {
          nodes: Array<{
            login: string;
          }>;
        };
      };
    }

    do {
      const query = `
        query ($enterprise: String!, $after: String) {
          enterprise(slug: $enterprise) {
            organizations(first: 100, after: $after) {
              pageInfo {
                endCursor
                hasNextPage
              }
              nodes {
                login
              }
            }
          }
        }
      `;

      const variables = { "enterprise": input.enterprise, "after": afterCursor };
      const response = await octokit.graphql<GraphQlResponse>(query, variables);
      organizations = organizations.concat(response.enterprise.organizations.nodes.map(org => org.login));

      hasNextPage = response.enterprise.organizations.pageInfo.hasNextPage;
      afterCursor = response.enterprise.organizations.pageInfo.endCursor;
      
    } while (hasNextPage);

    core.info(`Found ${organizations.length} organizations: ${organizations.join(', ')}`);

  } else {
    // Split org input by comma (to allow multiple orgs)
    organizations = input.org.split(',').map(org => org.trim());
  }


  for (const org of organizations) {
    // Process each organization
    const seats = await getOrgData(org, octokit);
    
    /*const seats = await core.group('Fetching GitHub Copilot seats for ' + org, async () => {

      // No type exists for copilot endpoint yet
      let _seats: Endpoints["GET /orgs/{org}/copilot/billing/seats"]["response"]['data']['seats'] = [], totalSeats = 0, page = 1;
      do {
        try {
          const response = await octokit.request(`GET /orgs/{org}/copilot/billing/seats?per_page=100&page=${page}`, {
            org: org
          });
          totalSeats = response.data.total_seats;
          _seats = _seats.concat(response.data.seats);
          page++;
        } catch (error) {
          if (error instanceof RequestError && error.message === "Copilot Business is not enabled for this organization.") {
            core.error((error as Error).message + ` (${org})`);
            break;
          } else if (error instanceof RequestError && error.status === 404) {
            core.error((error as Error).message + ` (${org}).  Please ensure that the organization has GitHub Copilot enabled and you are an org owner.`);
            break;
          } else {
            throw error;
          }
        }
      } while (_seats.length < totalSeats);
      core.info(`Found ${_seats.length} seats`)
      core.info(JSON.stringify(_seats, null, 2));
      return _seats;
    });
    */

    /*
    const msToDays = (d) => Math.ceil(d / (1000 * 3600 * 24));

    const now = new Date();
    const inactiveSeats = seats.filter(seat => {
      if (seat.last_activity_at === null || seat.last_activity_at === undefined) {
        const created = new Date(seat.created_at);
        const diff = now.getTime() - created.getTime();
        return msToDays(diff) > input.inactiveDays;
      }
      const lastActive = new Date(seat.last_activity_at);
      const diff = now.getTime() - lastActive.getTime();
      return msToDays(diff) > input.inactiveDays;
    }).sort((a, b) => (
      a.last_activity_at === null || a.last_activity_at === undefined || b.last_activity_at === null || b.last_activity_at === undefined ?
      -1 : new Date(a.last_activity_at).getTime() - new Date(b.last_activity_at).getTime()
    ));
    */

    const inactiveSeats = getInactiveSeats(org, seats, input.inactiveDays);

    /*
    const inactiveSeatsWithOrg = inactiveSeats.map(seat => ({ ...seat, organization: org } as SeatWithOrg));
    allInactiveSeats = [...allInactiveSeats, ...inactiveSeatsWithOrg];
    */

    allInactiveSeats = [...allInactiveSeats, ...inactiveSeats];
    allSeatsCount += seats.length;

    if (input.removeInactive) {
      const inactiveSeatsAssignedIndividually = inactiveSeats.filter(seat => !seat.assigning_team);
      if (inactiveSeatsAssignedIndividually.length > 0) {
        core.group('Removing inactive seats', async () => {
          const response = await octokit.request(`DELETE /orgs/{org}/copilot/billing/selected_users`, {
            org: org,
            selected_usernames: inactiveSeatsAssignedIndividually.map(seat => seat.assignee.login),
          });
          core.info(`Removed ${response.data.seats_cancelled} seats`);
          console.log(typeof response.data.seats_cancelled);
          allRemovedSeatsCount += response.data.seats_cancelled;
        });
      }
    }

    if (input.removefromTeam) {
      const inactiveSeatsAssignedByTeam = inactiveSeats.filter(seat => seat.assigning_team);
      core.group('Removing inactive seats from team', async () => {
        for (const seat of inactiveSeatsAssignedByTeam) {
          if (!seat.assigning_team || typeof(seat.assignee.login) !== 'string') continue;
          await octokit.request('DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}', {
            org: org,
            team_slug: seat.assigning_team.slug,
            username: seat.assignee.login
          })
        }
      });
    }

    if (input.jobSummary) {
      await core.summary
        .addHeading(`${org} - Inactive Seats: ${inactiveSeats.length.toString()} / ${seats.length.toString()}`)
        if (seats.length > 0) {
          core.summary.addTable([
            [
              { data: 'Avatar', header: true },
              { data: 'Login', header: true },
              { data: 'Last Activity', header: true },
              { data: 'Last Editor Used', header: true }
            ],
            ...inactiveSeats.sort((a, b) => {
              const loginA = (a.assignee.login || 'Unknown') as string;
              const loginB = (b.assignee.login || 'Unknown') as string;
              return loginA.localeCompare(loginB);
            }).map(seat => [
              `<img src="${seat.assignee.avatar_url}" width="33" />`,
              seat.assignee.login || 'Unknown',
              seat.last_activity_at === null ? 'No activity' : momemt(seat.last_activity_at).fromNow(),
              seat.last_activity_editor || 'Unknown'
            ] as SummaryTableRow)
          ])
        }
        core.summary.addLink('Manage GitHub Copilot seats', `https://github.com/organizations/${org}/settings/copilot/seat_management`)
        .write()
    }
  }

  if (input.deployUsers) {
    core.info(`Fetching all deployment information from CSV ${input.deployUsersCsv}...`);
    // Get users from deployUsersCsv Input
    
    type UserList = {
      organization: string;
      deployment_group: string;
      login: string;
      activation_date: string;
    };
    

    try {  
      const csvFilePath = path.resolve(process.env.GITHUB_WORKSPACE || __dirname, input.deployUsersCsv);
    
      // Check if the file exists before trying to read it
      if (!existsSync(csvFilePath)) {
        core.setFailed(`File not found: ${csvFilePath}`);
        return;
      }
    
      const fileContent = readFileSync(csvFilePath, { encoding: 'utf-8' });
      core.debug(`File content: ${fileContent}`)

      const records: UserList[] = parse(fileContent, { 
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });

      const usersToDeploy: UserList[] = records.filter(record => {
        core.debug(`Record: ${JSON.stringify(record)}`);

        // Check for empty values
        const hasEmptyValues = Object.values(record).some(value => value === '');
        
        // Check for valid date
        const date = new Date(record.activation_date);
        const hasInvalidDate = isNaN(date.getTime());
        
        if (hasEmptyValues || hasInvalidDate) {
          console.error(`Skipping record with ${hasEmptyValues ? 'empty values' : 'invalid date'}: ${JSON.stringify(record)}`);
          return false;
        } else {
          
          // Check that record.activation_date is within input.deployValidationTime days from today.
          const today = new Date();
          const currentTime = today.getTime();
          const validationTime = today.setDate(today.getDate() - input.deployValidationTime);
          const activationTime = date.getTime();  // date = record.activation_date
          const isDateWithinWindow = validationTime <= activationTime  && activationTime <= currentTime;;

          if (!isDateWithinWindow) {
            console.error(`Skipping record due to activation date outside ${input.deployValidationTime} day window: ${JSON.stringify(record)}`);
            return false;
          }

          // Record is good and within deployment date window.  Add to usersToDeploy array
          return true;
        }

      });

      console.log("Users to deploy: ", usersToDeploy);

      usersToDeploy.forEach(user => {
        console.log(user);

        // TODO - Check if user exists as organization member
        // TODO - Check if user exists in the enterprise
        // TODO - Check if user is already deployed.  If so, skip.
      });

      // TODO - Capture groups above 
      // TODO - Add some API limits calculations (just to ensure we don't hit the limit unexpectedly)
        // i.e. you could have 10,000 users in an org.  Don't check them one by one.  (10,000 users = 100 API calls with pagination)
        // Split out get users by org into a separate function and data structure when checking for use in deployment
        // I also need this data to show active users in the summary output for deployments
        // I should also capture inactive users per deployment group as an output... So I can take action on them later.
      // TODO - Check if user exists as organization member
      // TODO - Check if user exists in the enterprise
      // TODO - Allow add to team?  
      // TODO - Check if user is already deployed.  If so, skip.
      // TODO - Add ability to enable copilot for user
      // TODO - Add example save deployed users to JSON as a file
      // TODO - Add Summary Output - Number of users deployed per group, active or not?  
      // TODO - Add CSV Output
      // TODO - Make the CSV policy - Add ability for it to be source of truth and remove users not in CSV
      // TODO - Review Readme Org admin requirement - Potential solution: https://github.com/some-natalie/gh-org-admin-promote

      

    } catch (err) {
      console.error(err);
    }


  }

  // Write CSV if requested (for all orgs)
  if (input.csv) {
    core.group('Writing CSV', async () => {
      // Sort by organization and then by login
      const sortedSeats = allInactiveSeats.sort((a, b) => {
        if (a.organization < b.organization) return -1;
        if (a.organization > b.organization) return 1;
        if (a.assignee.login < b.assignee.login) return -1;
        if (a.assignee.login > b.assignee.login) return 1;
        return 0;
      });

      const csv = [
        ['Organization', 'Login', 'Last Activity', 'Last Editor Used'],
        ...sortedSeats.map(seat => [
          seat.organization,
          seat.assignee.login,
          seat.last_activity_at === null ? 'No activity' : momemt(seat.last_activity_at).fromNow(),
          seat.last_activity_editor || '-'
        ])
      ].map(row => row.join(',')).join('\n');
      writeFileSync('inactive-seats.csv', csv);
      const artifactClient = artifact.create();
      await artifactClient.uploadArtifact('inactive-seats', ['inactive-seats.csv'], '.');
    });
  }

  // Set Outputs:
  core.setOutput('inactive-seats', JSON.stringify(allInactiveSeats));
  core.setOutput('inactive-seat-count', allInactiveSeats.length.toString());
  core.setOutput('seat-count', allSeatsCount.toString());
  core.setOutput('removed-seats', allRemovedSeatsCount.toString());
};

run();
