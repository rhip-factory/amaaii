// P1-E: ported 1:1 from utils/userManager.js (final step of the TS
// migration — see CLAUDE.md).

import * as db from './database';
import { log } from './logger';
import type { UpdateUserInput, UserRow } from '@amaaii/core';

/** UserRow plus the `isNewUser` flag getOrCreateUser() stamps onto it —
 *  mirrors the original JS's dynamic `user.isNewUser = ...` mutation. */
export type UserWithFlag = UserRow & { isNewUser: boolean };

export interface UserContext {
  isNewUser: boolean;
  hasProfile: boolean;
  pregnancyStage: string;
  daysToDelivery: number | null;
  needsOnboarding: boolean;
}

class UserManager {
  async getOrCreateUser(phoneNumber: string, profileName: string | null = null): Promise<UserWithFlag> {
    try {
      // `user` is dynamically extended with `isNewUser` below, matching
      // the original JS's mutation-based approach — including the edge
      // case where a create+get race could leave `user` undefined and
      // the `!` assertion below throws, caught by the catch block, same
      // as the original's implicit "reading .isNewUser off undefined".
      let user = (await db.getUser(phoneNumber)) as (UserRow & { isNewUser?: boolean }) | undefined;

      if (!user) {
        await db.createUser(phoneNumber, { name: profileName ?? undefined });
        user = (await db.getUser(phoneNumber)) as (UserRow & { isNewUser?: boolean }) | undefined;
        user!.isNewUser = true;
      } else {
        user.isNewUser = false;
      }

      return user as UserWithFlag;
    } catch (error) {
      log.error('Error in getOrCreateUser', error);
      throw error;
    }
  }

  async updateUserProfile(phoneNumber: string, updates: Record<string, unknown>): Promise<UserRow | undefined> {
    try {
      const validFields = [
        'name', 'age', 'pregnancy_week', 'edd',
        'location', 'lmp', 'risk_level', 'anc_visits',
      ];

      const filteredUpdates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (validFields.includes(key)) {
          filteredUpdates[key] = value;
        }
      }

      if (Object.keys(filteredUpdates).length > 0) {
        // Keys are whitelisted against `validFields` above (a superset
        // of UpdateUserInput's keys); the cast documents that runtime
        // check rather than re-deriving it in the type system.
        await db.updateUser(phoneNumber, filteredUpdates as UpdateUserInput);
      }

      return await db.getUser(phoneNumber);
    } catch (error) {
      log.error('Error updating user profile', error);
      throw error;
    }
  }

  calculatePregnancyWeek(lmp?: string | null): number | null {
    if (!lmp) return null;

    const lmpDate = new Date(lmp);
    const today = new Date();
    const diffTime = Math.abs(today.getTime() - lmpDate.getTime());
    const diffWeeks = Math.floor(diffTime / (1000 * 60 * 60 * 24 * 7));

    return diffWeeks;
  }

  calculateEDD(lmp?: string | null): string | null {
    if (!lmp) return null;

    const lmpDate = new Date(lmp);
    const edd = new Date(lmpDate);
    edd.setDate(edd.getDate() + 280);

    return edd.toISOString().split('T')[0];
  }

  assessRiskLevel(user: Pick<UserRow, 'age' | 'pregnancy_week'>, symptoms: string[] = []): 'high' | 'moderate' | 'low' {
    const riskFactors: string[] = [];

    if (user.age && (user.age < 18 || user.age > 35)) {
      riskFactors.push('age');
    }

    if (user.pregnancy_week && user.pregnancy_week < 12) {
      riskFactors.push('first_trimester');
    }

    if (user.pregnancy_week && user.pregnancy_week > 36) {
      riskFactors.push('near_term');
    }

    const highRiskSymptoms = ['bleeding', 'severe_headache', 'vision_changes', 'severe_pain'];
    const hasHighRiskSymptoms = symptoms.some((s) => highRiskSymptoms.includes(s));

    if (hasHighRiskSymptoms) {
      riskFactors.push('danger_signs');
    }

    if (riskFactors.includes('danger_signs')) {
      return 'high';
    } else if (riskFactors.length >= 2) {
      return 'moderate';
    } else {
      return 'low';
    }
  }

  getUserContext(user: UserWithFlag): UserContext {
    const context: UserContext = {
      isNewUser: user.isNewUser || false,
      hasProfile: !!(user.name && user.age && user.pregnancy_week),
      pregnancyStage: this.getPregnancyStage(user.pregnancy_week),
      daysToDelivery: this.getDaysToDelivery(user.edd),
      // Stays true until name, age, week, AND location are all set;
      // otherwise handleOnboarding's location step is never reached
      // (the router skips onboarding once this flag flips).
      needsOnboarding: !user.name || !user.age || !user.pregnancy_week || !user.location,
    };

    return context;
  }

  getPregnancyStage(weeks?: number | null): string {
    if (!weeks) return 'unknown';

    if (weeks < 13) return 'first_trimester';
    if (weeks < 27) return 'second_trimester';
    if (weeks <= 42) return 'third_trimester';
    return 'postterm';
  }

  getDaysToDelivery(edd?: string | null): number | null {
    if (!edd) return null;

    const eddDate = new Date(edd);
    const today = new Date();
    const diffTime = eddDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return diffDays;
  }

  formatUserSummary(user: Partial<UserRow>): string {
    const summary: string[] = [];

    if (user.name) summary.push(`Name: ${user.name}`);
    if (user.age) summary.push(`Age: ${user.age}`);
    if (user.pregnancy_week) summary.push(`Week: ${user.pregnancy_week}`);
    if (user.edd) summary.push(`Due: ${user.edd}`);
    if (user.location) summary.push(`Location: ${user.location}`);

    return summary.join(' | ');
  }
}

export default new UserManager();
