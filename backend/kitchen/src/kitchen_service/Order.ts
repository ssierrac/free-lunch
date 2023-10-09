/**
 * @property order_id - ID of the order
 * @property order_status - Status of the order
 * @property recipe_name - Name of the recipe
 * @property order_created - date of order creation
 * @property order_last_modified_on - date of order last modification
 */
export type OrderDBType = {
    order_id: string
    order_status?: OrderStatusEnum
    recipe_id?: string
    order_created?: string
    order_last_modified_on?: string
}

/**
 * @enum {string}
 * @property ACCEPTED - The order has been accepted
 * @property CANCELLED - The order has been Cancelled
 * @property DELIVERED - The order has been delivered
 */
export enum OrderStatusEnum {
    ACCEPTED = "ACCEPTED",
    CANCELLED = "CANCELLED",
    DELIVERED = "DELIVERED"
}

export interface OrderError extends Error {
    orderId: string
    object?: any
}

export interface OrderResponse {
    orderId: string
    object?: any
}