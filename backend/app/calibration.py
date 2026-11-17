"""Calorie and macronutrient calibration using Mifflin-St Jeor and daily status evaluation."""

from __future__ import annotations

from dataclasses import asdict, dataclass

SEX_BMR_OFFSETS: dict[str, float] = {
    "male": 5.0,
    "female": -161.0,
    "other": -78.0,
}

ACTIVITY_MULTIPLIERS: dict[str, float] = {
    "sedentary": 1.2,
    "light": 1.375,
    "moderate": 1.55,
    "active": 1.725,
    "very_active": 1.9,
}

GOAL_CALORIE_ADJUSTMENTS: dict[str, float] = {
    "lose": -450.0,
    "maintain": 0.0,
    "gain": 300.0,
}

GOAL_PROTEIN_G_PER_KG: dict[str, float] = {
    "lose": 2.0,
    "maintain": 1.6,
    "gain": 1.8,
}

MIN_TARGET_CALORIES = 1200.0
MIN_CARBS_G = 50.0
FAT_CALORIE_SHARE = 0.27


@dataclass(frozen=True)
class CalibratedTargets:
    """Computed daily calorie and macro targets."""

    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float

    def to_dict(self) -> dict[str, float]:
        """Return targets as a plain dictionary."""
        return asdict(self)


def calculate_bmr(*, weight_kg: float, height_cm: float, age: int, sex: str) -> float:
    """Compute Basal Metabolic Rate (kcal/day) via the Mifflin-St Jeor equation."""
    normalized_sex = sex.strip().lower()
    if normalized_sex not in SEX_BMR_OFFSETS:
        raise ValueError(f"Unsupported sex value: {sex!r}")
    return (10.0 * weight_kg) + (6.25 * height_cm) - (5.0 * age) + SEX_BMR_OFFSETS[normalized_sex]


def calibrate_targets(
    *,
    height_cm: float,
    weight_kg: float,
    age: int,
    sex: str,
    activity_level: str,
    goal: str,
) -> CalibratedTargets:
    """Calculate personalized calorie and macro targets from user biometrics and goal."""
    normalized_activity = activity_level.strip().lower()
    if normalized_activity not in ACTIVITY_MULTIPLIERS:
        raise ValueError(f"Unsupported activity_level: {activity_level!r}")

    normalized_goal = goal.strip().lower()
    if normalized_goal not in GOAL_CALORIE_ADJUSTMENTS:
        raise ValueError(f"Unsupported goal: {goal!r}")

    bmr = calculate_bmr(weight_kg=weight_kg, height_cm=height_cm, age=age, sex=sex)
    tdee = bmr * ACTIVITY_MULTIPLIERS[normalized_activity]
    target_calories = float(round(max(MIN_TARGET_CALORIES, tdee + GOAL_CALORIE_ADJUSTMENTS[normalized_goal])))

    protein_g = round(weight_kg * GOAL_PROTEIN_G_PER_KG[normalized_goal], 1)
    fat_g = round((target_calories * FAT_CALORIE_SHARE) / 9.0, 1)
    remaining_kcal = target_calories - (protein_g * 4.0) - (fat_g * 9.0)
    carbs_g = round(max(MIN_CARBS_G, remaining_kcal / 4.0), 1)

    return CalibratedTargets(
        calories=target_calories,
        protein_g=protein_g,
        carbs_g=carbs_g,
        fat_g=fat_g,
    )


def evaluate_daily_status(
    *,
    target_calories: float,
    target_protein_g: float,
    consumed_calories: float,
    consumed_protein_g: float,
    meal_count: int,
) -> dict[str, object]:
    """Classify daily calorie and protein progress against targets."""
    if target_calories <= 0:
        cal_status = "on_track" if consumed_calories == 0 else "over"
    elif consumed_calories < target_calories * 0.90:
        cal_status = "under"
    elif consumed_calories <= target_calories * 1.05:
        cal_status = "on_track"
    else:
        cal_status = "over"

    if target_protein_g <= 0:
        protein_status = "met" if consumed_protein_g == 0 else "exceeded"
    elif consumed_protein_g < target_protein_g * 0.90:
        protein_status = "under"
    elif consumed_protein_g <= target_protein_g * 1.20:
        protein_status = "met"
    else:
        protein_status = "exceeded"

    meeting_goals = (cal_status == "on_track") and (protein_status in ("met", "exceeded"))

    if meal_count == 0:
        summary = (
            f"No meals logged yet. Target: {round(target_calories):.0f} kcal "
            f"and {round(target_protein_g):.0f}g protein."
        )
    elif meeting_goals:
        summary = (
            f"On track: {round(consumed_calories):.0f} / {round(target_calories):.0f} kcal "
            f"and {round(consumed_protein_g):.0f}g / {round(target_protein_g):.0f}g protein."
        )
    elif cal_status == "over":
        over_kcal = max(0.0, consumed_calories - target_calories)
        if protein_status == "under":
            short_protein = max(0.0, target_protein_g - consumed_protein_g)
            summary = (
                f"Over calorie target by {round(over_kcal):.0f} kcal "
                f"and {round(short_protein):.0f}g short on protein."
            )
        else:
            summary = (
                f"Over calorie target by {round(over_kcal):.0f} kcal; "
                f"protein goal met ({round(consumed_protein_g):.0f}g)."
            )
    elif cal_status == "under":
        rem_kcal = max(0.0, target_calories - consumed_calories)
        if protein_status == "under":
            short_protein = max(0.0, target_protein_g - consumed_protein_g)
            summary = (
                f"{round(rem_kcal):.0f} kcal remaining and "
                f"{round(short_protein):.0f}g protein still needed today."
            )
        else:
            summary = (
                f"Protein target met ({round(consumed_protein_g):.0f}g / "
                f"{round(target_protein_g):.0f}g); {round(rem_kcal):.0f} kcal remaining."
            )
    else:
        short_protein = max(0.0, target_protein_g - consumed_protein_g)
        summary = (
            f"Calories on track ({round(consumed_calories):.0f} / {round(target_calories):.0f} kcal), "
            f"need {round(short_protein):.0f}g more protein."
        )

    return {
        "calories": cal_status,
        "protein": protein_status,
        "meeting_goals": meeting_goals,
        "summary": summary,
    }
