export type RecipeDBType = {
    recipe_id?: string
    name: string
    ingredients: Array<IngredientDBType>
    recipe_created?: string
    recipe_last_modified_on?: string
}

export type IngredientDBType = {
    name: string
    qty: number
}

export interface RecipeError extends Error {
    recipe_id: string
    object?: any
}