describe('/#/basket', () => {
  describe('as admin', () => {
    beforeEach(() => {
      cy.login({ email: 'admin', password: 'admin123' })
    })

    describe('challenge "negativeOrder"', () => {

    })

    describe('challenge "basketAccessChallenge"', () => {
    })

    describe('challenge "basketManipulateChallenge"', () => {
    })
  })

  describe('as jim', () => {
    beforeEach(() => {
      cy.login({ email: 'jim', password: 'ncc-1701' })
    })
    describe('challenge "manipulateClock"', () => {
    })

    describe('challenge "forgedCoupon"', () => {

      it('should be possible to add a product in the basket', () => {
        cy.window().then(async () => {
          const response = await fetch(
            `${Cypress.config('baseUrl')}/api/BasketItems/`,
            {
              method: 'POST',
              cache: 'no-cache',
              headers: {
                'Content-type': 'application/json',
                Authorization: `Bearer ${localStorage.getItem('token')}`
              },
              body: JSON.stringify({
                BasketId: `${sessionStorage.getItem('bid')}`,
                ProductId: 1,
                quantity: 1
              })
            }
          )
          if (response.status === 201) {
            console.log('Success')
          }
        })
      })

      it('should be possible to enter a coupon that gives an 80% discount', () => {
        cy.window().then(() => {
          window.localStorage.couponPanelExpanded = false
        })

        cy.visit('/#/payment/shop')
        cy.get('#collapseCouponElement').click()
        cy.task<string>('GenerateCoupon', 90).then((coupon: string) => {
          cy.get('#coupon').type(coupon)
          cy.get('#applyCouponButton').click()
        })
      })

    })
  })
})
