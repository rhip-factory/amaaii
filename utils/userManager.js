const db = require('../services/database');

class UserManager {
  async getOrCreateUser(phoneNumber, profileName = null) {
    try {
      let user = await db.getUser(phoneNumber);
      
      if (!user) {
        await db.createUser(phoneNumber, { name: profileName });
        user = await db.getUser(phoneNumber);
        user.isNewUser = true;
      } else {
        user.isNewUser = false;
      }
      
      return user;
    } catch (error) {
      console.error('Error in getOrCreateUser:', error);
      throw error;
    }
  }
  
  async updateUserProfile(phoneNumber, updates) {
    try {
      const validFields = [
        'name', 'age', 'pregnancy_week', 'edd', 
        'location', 'lmp', 'risk_level', 'anc_visits'
      ];
      
      const filteredUpdates = {};
      for (const [key, value] of Object.entries(updates)) {
        if (validFields.includes(key)) {
          filteredUpdates[key] = value;
        }
      }
      
      if (Object.keys(filteredUpdates).length > 0) {
        await db.updateUser(phoneNumber, filteredUpdates);
      }
      
      return await db.getUser(phoneNumber);
    } catch (error) {
      console.error('Error updating user profile:', error);
      throw error;
    }
  }
  
  calculatePregnancyWeek(lmp) {
    if (!lmp) return null;
    
    const lmpDate = new Date(lmp);
    const today = new Date();
    const diffTime = Math.abs(today - lmpDate);
    const diffWeeks = Math.floor(diffTime / (1000 * 60 * 60 * 24 * 7));
    
    return diffWeeks;
  }
  
  calculateEDD(lmp) {
    if (!lmp) return null;
    
    const lmpDate = new Date(lmp);
    const edd = new Date(lmpDate);
    edd.setDate(edd.getDate() + 280);
    
    return edd.toISOString().split('T')[0];
  }
  
  assessRiskLevel(user, symptoms = []) {
    let riskFactors = [];
    
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
    const hasHighRiskSymptoms = symptoms.some(s => highRiskSymptoms.includes(s));
    
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
  
  getUserContext(user) {
    const context = {
      isNewUser: user.isNewUser || false,
      hasProfile: !!(user.name && user.age && user.pregnancy_week),
      pregnancyStage: this.getPregnancyStage(user.pregnancy_week),
      daysToDelivery: this.getDaysToDelivery(user.edd),
      needsOnboarding: !user.age || !user.pregnancy_week
    };
    
    return context;
  }
  
  getPregnancyStage(weeks) {
    if (!weeks) return 'unknown';
    
    if (weeks < 13) return 'first_trimester';
    if (weeks < 27) return 'second_trimester';
    if (weeks <= 42) return 'third_trimester';
    return 'postterm';
  }
  
  getDaysToDelivery(edd) {
    if (!edd) return null;
    
    const eddDate = new Date(edd);
    const today = new Date();
    const diffTime = eddDate - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays;
  }
  
  formatUserSummary(user) {
    const summary = [];
    
    if (user.name) summary.push(`Name: ${user.name}`);
    if (user.age) summary.push(`Age: ${user.age}`);
    if (user.pregnancy_week) summary.push(`Week: ${user.pregnancy_week}`);
    if (user.edd) summary.push(`Due: ${user.edd}`);
    if (user.location) summary.push(`Location: ${user.location}`);
    
    return summary.join(' | ');
  }
}

module.exports = new UserManager();