const db = require('./database');
const { detectDangerSigns, assessMood, extractSymptoms } = require('./dangerSigns');

class JournalManager {
  constructor() {
    this.journalSessions = new Map();
  }

  async startJournalSession(userPhone, user) {
    const existingJournal = await db.getTodaysJournal(userPhone);
    
    const session = {
      userPhone,
      userName: user.name,
      pregnancyWeek: user.pregnancy_week,
      currentStage: existingJournal ? 'continue' : 'greeting',
      journalData: existingJournal || {},
      startTime: new Date()
    };
    
    this.journalSessions.set(userPhone, session);
    return session;
  }

  getJournalSession(userPhone) {
    return this.journalSessions.get(userPhone);
  }

  async processJournalResponse(userPhone, message, currentStage) {
    let session = this.journalSessions.get(userPhone);
    if (!session) {
      return { error: true, message: "No active journal session" };
    }

    let nextStage, response, journalUpdate = {};

    switch(currentStage) {
      case 'greeting':
        nextStage = 'mood';
        response = `Let's do your daily check-in! 📝\n\nFirst, how are you feeling emotionally today? (Rate 1-10, where 1 is very low and 10 is excellent)`;
        break;

      case 'continue':
        nextStage = 'mood';
        response = `Welcome back! Let's continue your daily check-in 📝\n\nHow are you feeling emotionally right now? (1-10)`;
        break;

      case 'mood':
        const moodScore = this.extractNumber(message);
        if (moodScore && moodScore >= 1 && moodScore <= 10) {
          journalUpdate.emotional_state = moodScore;
          journalUpdate.mood_description = message;
          nextStage = 'symptoms';
          
          let moodResponse = moodScore >= 7 ? "That's wonderful to hear! 😊" :
                            moodScore >= 5 ? "Thank you for sharing." :
                            "I'm here for you. 💚";
          
          response = `${moodResponse}\n\nAny physical symptoms today? (e.g., nausea, headache, back pain, or type 'none')`;
        } else {
          nextStage = 'mood';
          response = "Please rate your mood from 1 to 10 (1 being very low, 10 being excellent)";
        }
        break;

      case 'symptoms':
        const symptoms = extractSymptoms(message);
        const dangerAnalysis = detectDangerSigns(message);
        
        journalUpdate.physical_symptoms = symptoms.length > 0 ? JSON.stringify(symptoms) : 
                                         message.toLowerCase().includes('none') ? 'none' : message;
        
        if (dangerAnalysis.urgencyLevel === 'critical' || dangerAnalysis.urgencyLevel === 'high') {
          journalUpdate.red_flags_detected = JSON.stringify(dangerAnalysis.detectedSigns);
          response = dangerAnalysis.recommendedAction + "\n\nWe'll pause the journal for now. Please seek care first!";
          nextStage = 'completed';
        } else {
          nextStage = 'sleep';
          response = `I've noted your symptoms.\n\nHow was your sleep last night? Rate quality (1-10) and hours slept (e.g., "7/10, 6 hours")`;
        }
        break;

      case 'sleep':
        const sleepMatch = message.match(/(\d+).*?(\d+(?:\.\d+)?)\s*h/i);
        const qualityMatch = message.match(/(\d+)/);
        
        if (qualityMatch) {
          journalUpdate.sleep_quality = parseInt(qualityMatch[1]);
        }
        if (sleepMatch && sleepMatch[2]) {
          journalUpdate.sleep_hours = parseFloat(sleepMatch[2]);
        } else if (message.match(/(\d+(?:\.\d+)?)\s*h/i)) {
          journalUpdate.sleep_hours = parseFloat(message.match(/(\d+(?:\.\d+)?)\s*h/i)[1]);
        }
        
        nextStage = session.pregnancyWeek >= 20 ? 'baby_movement' : 'water';
        response = session.pregnancyWeek >= 20 ? 
          `How many times did you feel baby move today? (It's okay if you're not sure yet)` :
          `How many glasses of water did you drink today? (Aim for 8-10 glasses)`;
        break;

      case 'baby_movement':
        const movementCount = this.extractNumber(message);
        if (movementCount !== null) {
          journalUpdate.baby_movement_count = movementCount;
          
          if (movementCount === 0 && session.pregnancyWeek > 28) {
            journalUpdate.red_flags_detected = JSON.stringify(['no_fetal_movement']);
            response = `⚠️ No movement detected. If you haven't felt baby move in the last 12 hours, please contact your healthcare provider immediately.\n\nHow many glasses of water did you drink today?`;
          } else if (movementCount < 10 && session.pregnancyWeek > 28) {
            response = `Movement seems low. Try having a cold drink and lying on your left side for an hour to count movements.\n\nHow many glasses of water did you drink today?`;
          } else {
            response = `Good! Regular movement is a great sign. 👶\n\nHow many glasses of water did you drink today?`;
          }
        } else {
          journalUpdate.baby_movement_time = message;
          response = `I've noted that. How many glasses of water did you drink today?`;
        }
        nextStage = 'water';
        break;

      case 'water':
        const waterCount = this.extractNumber(message);
        if (waterCount !== null) {
          journalUpdate.water_intake = waterCount;
          
          let waterAdvice = waterCount >= 8 ? "Excellent hydration! 💧" :
                           waterCount >= 6 ? "Good! Try to increase a bit more." :
                           "Try to drink more water tomorrow. It's important for you and baby.";
          
          response = `${waterAdvice}\n\nHow was your appetite today? (good/moderate/poor)`;
        } else {
          response = "Please tell me how many glasses of water (e.g., '6' or '8 glasses')";
        }
        nextStage = 'appetite';
        break;

      case 'appetite':
        const appetiteLevel = message.toLowerCase().includes('good') ? 'good' :
                             message.toLowerCase().includes('poor') ? 'poor' : 
                             message.toLowerCase().includes('no') ? 'poor' : 'moderate';
        
        journalUpdate.appetite = appetiteLevel;
        nextStage = 'questions';
        response = `Any questions or concerns you want to discuss with your doctor at your next visit? (or type 'none')`;
        break;

      case 'questions':
        if (!message.toLowerCase().includes('none')) {
          journalUpdate.questions_for_doctor = message;
        }
        nextStage = 'notes';
        response = `Any other notes about your day? How you're feeling overall? (or type 'done' to finish)`;
        break;

      case 'notes':
        if (!message.toLowerCase().includes('done') && !message.toLowerCase().includes('no')) {
          journalUpdate.special_notes = message;
        }
        journalUpdate.completed = 1;
        nextStage = 'completed';
        
        const summary = await this.generateJournalSummary(session.journalData, journalUpdate);
        response = summary;
        break;

      case 'completed':
        response = "Today's journal is complete! Type 'journal summary' to see it again or 'weekly summary' for your week's progress.";
        break;
    }

    if (Object.keys(journalUpdate).length > 0) {
      await db.createOrUpdateJournal(userPhone, journalUpdate);
      session.journalData = { ...session.journalData, ...journalUpdate };
    }
    
    session.currentStage = nextStage;
    this.journalSessions.set(userPhone, session);

    return { response, nextStage, completed: nextStage === 'completed' };
  }

  async generateJournalSummary(existingData, newData) {
    const data = { ...existingData, ...newData };
    
    let summary = "📊 **Today's Journal Summary**\n\n";
    
    if (data.emotional_state) {
      const moodEmoji = data.emotional_state >= 7 ? '😊' : 
                       data.emotional_state >= 5 ? '😐' : '😔';
      summary += `**Mood:** ${data.emotional_state}/10 ${moodEmoji}\n`;
    }
    
    if (data.physical_symptoms) {
      const symptoms = typeof data.physical_symptoms === 'string' && data.physical_symptoms !== 'none' ? 
                      data.physical_symptoms : 'No symptoms';
      summary += `**Symptoms:** ${symptoms}\n`;
    }
    
    if (data.sleep_quality) {
      summary += `**Sleep:** ${data.sleep_quality}/10 quality`;
      if (data.sleep_hours) summary += `, ${data.sleep_hours} hours`;
      summary += '\n';
    }
    
    if (data.baby_movement_count !== undefined && data.baby_movement_count !== null) {
      const movementStatus = data.baby_movement_count >= 10 ? '✅' : '⚠️';
      summary += `**Baby Movement:** ${data.baby_movement_count} times ${movementStatus}\n`;
    }
    
    if (data.water_intake) {
      const waterStatus = data.water_intake >= 8 ? '✅' : '💧';
      summary += `**Water:** ${data.water_intake} glasses ${waterStatus}\n`;
    }
    
    if (data.appetite) {
      summary += `**Appetite:** ${data.appetite}\n`;
    }
    
    summary += "\n";
    
    if (data.red_flags_detected) {
      summary += "⚠️ **Important:** Some concerning symptoms detected. Please follow up with your healthcare provider.\n\n";
    }
    
    const recommendations = this.generateRecommendations(data);
    if (recommendations.length > 0) {
      summary += "**Recommendations:**\n";
      recommendations.forEach(rec => summary += `• ${rec}\n`);
    }
    
    summary += "\n✅ Journal saved! Great job taking care of yourself and baby today! 💚";
    
    return summary;
  }

  generateRecommendations(data) {
    const recommendations = [];
    
    if (data.emotional_state < 5) {
      recommendations.push("Consider talking to someone about how you're feeling");
    }
    
    if (data.sleep_hours && data.sleep_hours < 6) {
      recommendations.push("Try to get more rest - aim for 7-9 hours");
    }
    
    if (data.water_intake && data.water_intake < 8) {
      recommendations.push("Increase water intake to 8-10 glasses daily");
    }
    
    if (data.appetite === 'poor') {
      recommendations.push("Try small, frequent meals if appetite is low");
    }
    
    if (data.baby_movement_count !== undefined && data.baby_movement_count < 10) {
      recommendations.push("Monitor baby movements closely today");
    }
    
    return recommendations;
  }

  async getWeeklySummary(userPhone) {
    const history = await db.getJournalHistory(userPhone, 7);
    const analytics = await db.getJournalAnalytics(userPhone, 7);
    
    if (!history || history.length === 0) {
      return "No journal entries found for this week. Start journaling daily to track your pregnancy journey! 📝";
    }
    
    let summary = "📈 **Your Weekly Summary**\n\n";
    
    summary += `**Journals Completed:** ${analytics.journal_count}/7 days\n`;
    
    if (analytics.avg_mood) {
      summary += `**Average Mood:** ${analytics.avg_mood.toFixed(1)}/10\n`;
    }
    
    if (analytics.avg_energy) {
      summary += `**Average Energy:** ${analytics.avg_energy.toFixed(1)}/10\n`;
    }
    
    if (analytics.avg_sleep) {
      summary += `**Average Sleep Quality:** ${analytics.avg_sleep.toFixed(1)}/10\n`;
    }
    
    if (analytics.avg_water) {
      summary += `**Average Water Intake:** ${analytics.avg_water.toFixed(0)} glasses/day\n`;
    }
    
    if (analytics.red_flag_days > 0) {
      summary += `\n⚠️ **Alert:** Red flags detected on ${analytics.red_flag_days} day(s). Please discuss with your doctor.\n`;
    }
    
    const symptoms = this.extractWeeklySymptoms(history);
    if (symptoms.length > 0) {
      summary += `\n**Common Symptoms This Week:**\n`;
      symptoms.forEach(symptom => summary += `• ${symptom}\n`);
    }
    
    summary += this.generateWeeklyInsights(analytics, history);
    
    return summary;
  }

  extractWeeklySymptoms(history) {
    const symptomCount = {};
    
    history.forEach(entry => {
      if (entry.physical_symptoms && entry.physical_symptoms !== 'none') {
        try {
          const symptoms = JSON.parse(entry.physical_symptoms);
          if (Array.isArray(symptoms)) {
            symptoms.forEach(symptom => {
              symptomCount[symptom] = (symptomCount[symptom] || 0) + 1;
            });
          }
        } catch (e) {
          // Handle non-JSON symptoms
        }
      }
    });
    
    return Object.entries(symptomCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([symptom]) => symptom);
  }

  generateWeeklyInsights(analytics, history) {
    let insights = "\n💡 **Insights:**\n";
    
    if (analytics.avg_mood >= 7) {
      insights += "• You've had a positive week emotionally! 🌟\n";
    } else if (analytics.avg_mood < 5) {
      insights += "• Your mood has been low. Consider reaching out for support. 💚\n";
    }
    
    if (analytics.avg_water >= 8) {
      insights += "• Great hydration this week! Keep it up! 💧\n";
    } else {
      insights += "• Try to increase your water intake. 💧\n";
    }
    
    if (analytics.journal_count >= 6) {
      insights += "• Excellent journaling consistency! 📝\n";
    } else if (analytics.journal_count < 3) {
      insights += "• Try to journal more regularly to track your journey. 📝\n";
    }
    
    return insights;
  }

  async generateDoctorReport(userPhone, days = 30) {
    const history = await db.getJournalHistory(userPhone, days);
    const user = await db.getUser(userPhone);
    
    let report = `**Pregnancy Health Report**\n`;
    report += `Patient: ${user.name || 'Not provided'}\n`;
    report += `Age: ${user.age || 'Not provided'}\n`;
    report += `Current Week: ${user.pregnancy_week || 'Not provided'}\n`;
    report += `Report Period: Last ${days} days\n\n`;
    
    report += `**Summary of Symptoms:**\n`;
    const symptoms = this.extractWeeklySymptoms(history);
    symptoms.forEach(symptom => report += `• ${symptom}\n`);
    
    report += `\n**Red Flags Noted:**\n`;
    const redFlags = history.filter(j => j.red_flags_detected);
    if (redFlags.length > 0) {
      redFlags.forEach(entry => {
        report += `• ${entry.date}: ${entry.red_flags_detected}\n`;
      });
    } else {
      report += "• None\n";
    }
    
    report += `\n**Questions from Patient:**\n`;
    const questions = history.filter(j => j.questions_for_doctor)
                            .map(j => j.questions_for_doctor);
    if (questions.length > 0) {
      questions.forEach(q => report += `• ${q}\n`);
    } else {
      report += "• None\n";
    }
    
    return report;
  }

  extractNumber(message) {
    const match = message.match(/\d+/);
    return match ? parseInt(match[0]) : null;
  }

  isJournalCommand(message) {
    const commands = ['journal', 'daily check-in', 'check in', 'daily journal', 'start journal'];
    return commands.some(cmd => message.toLowerCase().includes(cmd));
  }

  isSummaryCommand(message) {
    const commands = ['journal summary', 'weekly summary', 'my progress', 'how am i doing'];
    return commands.some(cmd => message.toLowerCase().includes(cmd));
  }

  isDoctorReportCommand(message) {
    const commands = ['doctor report', 'generate report', 'medical summary'];
    return commands.some(cmd => message.toLowerCase().includes(cmd));
  }
}

module.exports = new JournalManager();